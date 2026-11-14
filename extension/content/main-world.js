/*
 * Messenger Message Saver - page hook.
 *
 * Runs inside the Facebook / Messenger page itself ("MAIN world") before any of
 * Facebook's own scripts, so it can see Messenger's network traffic:
 *   - reads incoming LightSpeed data (new messages, unsends, edits, photos, names)
 *     from the gateway WebSocket, the older MQTT socket and HTTP (GraphQL) replies,
 *   - optionally neutralises outgoing "Seen" (mark-read) and "typing" signals,
 *   - optionally makes the page believe it is in the background, so Messenger does
 *     not send "Seen" in end-to-end encrypted chats either,
 *   - copies Messenger desktop notifications (sender + text) as a last-resort backup.
 *
 * Nothing is sent anywhere: findings are handed to the extension's content script
 * through a DOM CustomEvent and stored locally by the extension.
 *
 * The same file is loaded by Node in the unit tests: there it only exports the pure
 * parsing functions and installs no hooks.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8');
  const MAX_SCAN_BYTES = 8 * 1024 * 1024; // ignore absurdly large frames

  function utf8Encode(str) {
    return textEncoder.encode(str);
  }

  function utf8Decode(u8) {
    return textDecoder.decode(u8);
  }

  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Returns a Uint8Array view for any binary WebSocket payload, else null. */
  function asBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* JSON that keeps 64-bit integers exact                               */
  /* ------------------------------------------------------------------ */
  // Messenger task payloads carry int64 ids (epoch_id, task ids, thread ids). A plain
  // JSON.parse -> JSON.stringify round trip would round them, so unsafe integers are
  // kept as raw JSON text (JSON.rawJSON, Chrome 114+). Without that API we refuse to
  // rewrite rather than risk corrupting a request.

  const HAS_RAW_JSON = typeof JSON.rawJSON === 'function' && typeof JSON.isRawJSON === 'function';

  function parseExact(text) {
    if (!HAS_RAW_JSON) return undefined;
    try {
      return JSON.parse(text, function (key, value, ctx) {
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && ctx && typeof ctx.source === 'string') {
          return JSON.rawJSON(ctx.source);
        }
        return value;
      });
    } catch (e) {
      return undefined;
    }
  }

  function stringifyExact(value) {
    return JSON.stringify(value);
  }

  /** Converts a parsed id (number, numeric string or raw JSON) to a decimal string. */
  function idToString(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'bigint') return v.toString();
    if (HAS_RAW_JSON && JSON.isRawJSON(v)) return JSON.stringify(v);
    return '';
  }

  function isTruthyFlag(v) {
    if (v === true) return true;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '' && v !== '0' && v !== 'false';
    if (HAS_RAW_JSON && v && JSON.isRawJSON(v)) return JSON.stringify(v) !== '0';
    return false;
  }

  /**
   * Parses text that may hold one JSON document, a "for (;;);"-prefixed one, or
   * several newline-separated documents (Facebook's streamed GraphQL replies).
   */
  function parseJsonDocuments(text) {
    const docs = [];
    if (typeof text !== 'string' || !text) return docs;
    let t = text.trim();
    if (t.startsWith('for (;;);')) t = t.slice(9);
    try {
      docs.push(JSON.parse(t));
      return docs;
    } catch (e) {
      /* fall through to line mode */
    }
    for (const line of t.split('\n')) {
      let l = line.trim();
      if (l.startsWith('for (;;);')) l = l.slice(9);
      if (!l || (l[0] !== '{' && l[0] !== '[')) continue;
      try {
        docs.push(JSON.parse(l));
      } catch (e) {
        /* ignore non-JSON line */
      }
    }
    return docs;
  }

  /* ------------------------------------------------------------------ */
  /* DGW gateway framing (wss://gateway.facebook.com/ws/lightspeed)      */
  /* ------------------------------------------------------------------ */
  // Byte layout (little endian), per mautrix-meta pkg/messagix/dgw/frames.go:
  //   Data (13)        : type, streamId u16, len u24, ackId u16 (bit15 = requiresAck), payload
  //   ExtendedData (17): same as Data plus one content-type byte before the payload
  //   EstablishStream  : 15, streamId u16, len u24, JSON parameters
  //   Ack (12)         : 12, streamId u16, len u24 (=2), ackId u16
  //   EndOfData (14)   : 14, streamId u16
  //   EndOfDataReason  : 16, streamId u16, len u24, reason...
  //   Drain (3)        : 3, len u24 (=1), reason
  //   Ping 9 / Pong 10 / Deauth 4: single byte
  // One WebSocket message can hold several frames back to back.

  const DGW = {
    DRAIN: 3,
    DEAUTH: 4,
    PING: 9,
    PONG: 10,
    ACK: 12,
    DATA: 13,
    EOD: 14,
    ESTABLISH: 15,
    EOD_REASON: 16,
    EXT_DATA: 17,
  };

  function u16le(b, o) {
    return b[o] | (b[o + 1] << 8);
  }

  function u24le(b, o) {
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  }

  /** Splits a DGW WebSocket message into frames. Returns null if it is not DGW. */
  function dgwParse(u8) {
    if (!u8 || !u8.length) return null;
    const frames = [];
    let o = 0;
    while (o < u8.length) {
      const start = o;
      const type = u8[o];
      const frame = { type };
      if (type === DGW.PING || type === DGW.PONG || type === DGW.DEAUTH) {
        o += 1;
      } else if (type === DGW.EOD) {
        if (o + 3 > u8.length) return null;
        frame.streamId = u16le(u8, o + 1);
        o += 3;
      } else if (type === DGW.DRAIN) {
        if (o + 5 > u8.length) return null;
        frame.reason = u8[o + 4];
        o += 5;
      } else if (type === DGW.ACK || type === DGW.DATA || type === DGW.EXT_DATA || type === DGW.ESTABLISH || type === DGW.EOD_REASON) {
        if (o + 6 > u8.length) return null;
        frame.streamId = u16le(u8, o + 1);
        const len = u24le(u8, o + 3);
        const end = o + 6 + len;
        if (end > u8.length) return null;
        if (type === DGW.DATA || type === DGW.EXT_DATA) {
          const header = type === DGW.EXT_DATA ? 3 : 2;
          if (len < header) return null;
          frame.ackId = u16le(u8, o + 6) & 0x7fff;
          frame.requiresAck = (u8[o + 7] & 0x80) !== 0;
          if (type === DGW.EXT_DATA) frame.contentType = u8[o + 8];
          frame.payload = u8.subarray(o + 6 + header, end);
        } else if (type === DGW.ESTABLISH) {
          frame.payload = u8.subarray(o + 6, end);
        } else if (type === DGW.ACK) {
          if (len !== 2) return null;
          frame.ackId = u16le(u8, o + 6);
        } else {
          if (len < 1) return null;
          frame.reason = u8[o + 6];
        }
        o = end;
      } else {
        return null; // unknown frame type: not DGW (or a format we do not understand)
      }
      frame.raw = u8.subarray(start, o);
      frames.push(frame);
    }
    return frames;
  }

  /** Encodes a Data / ExtendedData frame with a new payload, keeping its header fields. */
  function dgwEncodeData(frame, payload) {
    const ext = frame.type === DGW.EXT_DATA;
    const header = ext ? 3 : 2;
    const len = header + payload.length;
    if (len > 0xffffff) throw new Error('DGW frame too large');
    const out = new Uint8Array(6 + len);
    out[0] = frame.type;
    out[1] = frame.streamId & 0xff;
    out[2] = (frame.streamId >> 8) & 0xff;
    out[3] = len & 0xff;
    out[4] = (len >> 8) & 0xff;
    out[5] = (len >> 16) & 0xff;
    out[6] = frame.ackId & 0xff;
    out[7] = ((frame.ackId >> 8) & 0x7f) | (frame.requiresAck ? 0x80 : 0);
    if (ext) out[8] = frame.contentType & 0xff;
    out.set(payload, 6 + header);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* MQTT over WebSocket (wss://edge-chat.facebook.com/chat) - legacy    */
  /* ------------------------------------------------------------------ */

  /** Splits a buffer into MQTT packets; PUBLISH packets get topic + payload. */
  function mqttParse(u8) {
    if (!u8 || !u8.length) return null;
    const packets = [];
    let o = 0;
    while (o < u8.length) {
      const start = o;
      const b0 = u8[o++];
      const type = b0 >> 4;
      if (type < 1 || type > 14) return null;
      let remaining = 0;
      let mult = 1;
      let i = 0;
      let byte;
      do {
        if (o >= u8.length || i >= 4) return null;
        byte = u8[o++];
        remaining += (byte & 0x7f) * mult;
        mult *= 128;
        i++;
      } while (byte & 0x80);
      const end = o + remaining;
      if (end > u8.length) return null;
      const pkt = { type, flags: b0 & 0x0f, raw: u8.subarray(start, end) };
      if (type === 3) {
        if (o + 2 > end) return null;
        const qos = (b0 >> 1) & 3;
        const topicLen = (u8[o] << 8) | u8[o + 1];
        o += 2;
        if (o + topicLen > end) return null;
        pkt.topic = utf8Decode(u8.subarray(o, o + topicLen));
        o += topicLen;
        pkt.qos = qos;
        if (qos > 0) {
          if (o + 2 > end) return null;
          pkt.packetId = (u8[o] << 8) | u8[o + 1];
          o += 2;
        }
        pkt.payload = u8.subarray(o, end);
      }
      o = end;
      packets.push(pkt);
    }
    return packets;
  }

  function mqttEncodeRemainingLength(n) {
    const bytes = [];
    do {
      let digit = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) digit |= 0x80;
      bytes.push(digit);
    } while (n > 0);
    return Uint8Array.from(bytes);
  }

  /** Re-encodes a parsed PUBLISH packet with a new payload. */
  function mqttEncodePublish(pkt, payload) {
    const topic = utf8Encode(pkt.topic);
    const parts = [Uint8Array.of(topic.length >> 8, topic.length & 0xff), topic];
    if (pkt.qos > 0) parts.push(Uint8Array.of(pkt.packetId >> 8, pkt.packetId & 0xff));
    parts.push(payload);
    const body = concatBytes(parts);
    return concatBytes([Uint8Array.of((3 << 4) | pkt.flags), mqttEncodeRemainingLength(body.length), body]);
  }

  /* ------------------------------------------------------------------ */
  /* LightSpeed: find step programs and collect stored-procedure calls   */
  /* ------------------------------------------------------------------ */
  // A LightSpeed reply is {"name":..., "step":[...]} where "step" is a tiny program:
  //   [1, ...steps] BLOCK, [5, "procName", ...args] CALL_STORED_PROCEDURE,
  //   [19, "123"] int64 from string, [9] undefined, [2,k] LOAD, [3,k,v] STORE,
  //   [23, cond, then, else] IF ... (mautrix-meta pkg/messagix/lightspeed).
  // We never execute anything: we walk the tree and collect procedure calls.

  /** Recursively finds every LightSpeed "step" array inside parsed JSON. */
  function findLsSteps(value, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 12 || value === null || value === undefined) return out;
    if (typeof value === 'string') {
      if (value.length > 12 && (value[0] === '{' || value[0] === '[') && value.indexOf('"step"') !== -1) {
        try {
          findLsSteps(JSON.parse(value), out, depth + 1);
        } catch (e) {
          /* not JSON */
        }
      }
      return out;
    }
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v === 'object') findLsSteps(v, out, depth + 1);
      else if (typeof v === 'string' && v.length > 12) findLsSteps(v, out, depth + 1);
      return out;
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.step)) out.push(value.step);
      for (const k in value) {
        if (k === 'step') continue;
        const v = value[k];
        if (v && (typeof v === 'object' || (typeof v === 'string' && v.length > 12))) findLsSteps(v, out, depth + 1);
      }
    }
    return out;
  }

  // Result of a step whose value depends on Messenger's local database.
  const UNKNOWN = Object.freeze({ unknown: true });

  function lsTruthy(v) {
    if (v === UNKNOWN) return null;
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'string') return v !== '' && v !== '0';
    return null;
  }

  /** Walks a step program and returns [{name, args}] for every procedure call. */
  function lsCollectCalls(program) {
    const calls = [];
    const refs = new Map();
    let budget = 500000; // hard cap on visited nodes

    function dec(node, depth) {
      if (--budget < 0 || depth > 400) return null;
      if (!Array.isArray(node)) return node;
      if (!node.length) return null;
      const t = node[0];
      if (typeof t !== 'number') {
        // a literal list: walk it for safety, return as-is
        for (const n of node) if (Array.isArray(n)) dec(n, depth + 1);
        return null;
      }
      switch (t) {
        case 1: // BLOCK
          for (let i = 1; i < node.length; i++) dec(node[i], depth + 1);
          return null;
        case 2: // LOAD
          return refs.has(node[1]) ? refs.get(node[1]) : UNKNOWN;
        case 3: // STORE
          refs.set(node[1], dec(node[2], depth + 1));
          return null;
        case 4: // STORE_ARRAY (approximation, enough for walking)
          refs.set(node[1], node[2]);
          for (let i = 3; i < node.length; i++) dec(node[i], depth + 1);
          return null;
        case 5: {
          // CALL_STORED_PROCEDURE
          const name = node[1];
          if (typeof name !== 'string') return null;
          const args = new Array(Math.max(0, node.length - 2));
          for (let i = 2; i < node.length; i++) {
            const v = dec(node[i], depth + 1);
            args[i - 2] = v === UNKNOWN ? null : v;
          }
          calls.push({ name, args });
          return UNKNOWN;
        }
        case 8: {
          // LIST
          const list = [];
          for (let i = 1; i < node.length; i++) list.push(dec(node[i], depth + 1));
          return list;
        }
        case 9: // UNDEFINED
          return undefined;
        case 10:
          return Infinity;
        case 11:
          return NaN;
        case 13: // BOOL_TO_STR
          return String(dec(node[1], depth + 1));
        case 16: // TO_BLOB (base64) - keep the text
          return typeof node[1] === 'string' ? node[1] : null;
        case 17: // I64_OF_FLOAT
        case 18: // I64_TO_FLOAT
          return dec(node[1], depth + 1);
        case 19: // I64_FROM_STRING
          return typeof node[1] === 'string' ? node[1] : node[1] == null ? null : String(node[1]);
        case 20: // I64_TO_STRING
          return idToString(dec(node[1], depth + 1));
        case 23: {
          // IF cond then [else]
          const c = lsTruthy(dec(node[1], depth + 1));
          if (c === true) dec(node[2], depth + 1);
          else if (c === false) {
            if (node.length > 3 && node[3] != null) dec(node[3], depth + 1);
          } else {
            // condition depends on Messenger's local database: walk both branches
            dec(node[2], depth + 1);
            if (node.length > 3 && node[3] != null) dec(node[3], depth + 1);
          }
          return null;
        }
        case 26: {
          // NOT
          const v = lsTruthy(dec(node[1], depth + 1));
          return v === null ? UNKNOWN : !v;
        }
        case 60: // NATIVE_OP_CURRENT_TIME
          return Date.now();
        default:
          // unknown op: still look inside for nested procedure calls
          for (let i = 1; i < node.length; i++) if (Array.isArray(node[i])) dec(node[i], depth + 1);
          return UNKNOWN;
      }
    }

    dec(program, 0);
    return calls;
  }

  /* ------------------------------------------------------------------ */
  /* Turn procedure calls into saver events                              */
  /* ------------------------------------------------------------------ */
  // Argument indices come from mautrix-meta pkg/messagix/table/*.go (Nov 2026).

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    return 0;
  }

  function sid(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
  }

  const MESSAGE_PROCS = new Set(['insertMessage', 'upsertMessage', 'deleteThenInsertMessage']);

  function attachment(kind, o) {
    o.kind = kind;
    return o;
  }

  function emptyEvents() {
    return {
      messages: [],
      unsent: [],
      deleted: [],
      edits: [],
      editHistory: [],
      attachments: [],
      contacts: [],
      threads: [],
      snippets: [],
      reactions: [],
      readWatermarks: [],
      receipts: [],
    };
  }

  function hasEvents(ev) {
    for (const k in ev) if (ev[k].length) return true;
    return false;
  }

  function extractEvents(calls, ev) {
    ev = ev || emptyEvents();
    for (const call of calls) {
      const a = call.args;
      const name = call.name;
      if (MESSAGE_PROCS.has(name)) {
        const id = sid(a[8]);
        const threadKey = sid(a[3]);
        if (!id || !threadKey) continue;
        const isUnsent = a[17] === true || a[17] === 1;
        if (isUnsent) {
          ev.unsent.push({ id, threadKey, senderId: sid(a[10]), ts: num(a[5]), unsentTs: num(a[18]) });
          continue;
        }
        ev.messages.push({
          id,
          otid: sid(a[9]),
          threadKey,
          ts: num(a[5]),
          senderId: sid(a[10]),
          text: str(a[0]),
          stickerId: sid(a[11]),
          isAdmin: a[12] === true,
          replyToId: str(a[23]),
          replySnippet: str(a[27]),
          replyText: str(a[28]),
          proc: name,
        });
        continue;
      }
      switch (name) {
        case 'deleteMessage':
          if (sid(a[1])) ev.deleted.push({ threadKey: sid(a[0]), id: sid(a[1]) });
          break;
        case 'updateUnsentMessageCollapsedStatus':
          if (sid(a[1])) ev.unsent.push({ threadKey: sid(a[0]), id: sid(a[1]), ts: num(a[2]), weak: true });
          break;
        case 'editMessage':
          if (sid(a[0])) ev.edits.push({ id: sid(a[0]), text: str(a[2]), editCount: num(a[3]) });
          break;
        case 'updateOrInsertEditMessageHistory':
          if (sid(a[0])) ev.editHistory.push({ id: sid(a[0]), threadKey: sid(a[1]), ts: num(a[2]), text: str(a[3]) });
          break;
        case 'insertBlobAttachment':
          ev.attachments.push(
            attachment('blob', {
              filename: str(a[0]),
              playableUrl: str(a[3]),
              playableMime: str(a[6]),
              previewUrl: str(a[8]),
              previewMime: str(a[11]),
              width: num(a[14]),
              height: num(a[15]),
              durationMs: num(a[22]),
              threadKey: sid(a[27]),
              type: num(a[29]),
              mime: str(a[30]),
              ts: num(a[31]),
              messageId: sid(a[32]),
              fbid: sid(a[34]),
              title: str(a[38]),
            })
          );
          break;
        case 'insertAttachment':
          ev.attachments.push(
            attachment('attachment', {
              filename: str(a[1]),
              playableUrl: str(a[5]),
              playableMime: str(a[8]),
              previewUrl: str(a[10]),
              previewMime: str(a[13]),
              width: num(a[16]),
              height: num(a[17]),
              durationMs: num(a[25]),
              threadKey: sid(a[32]),
              type: num(a[34]),
              mime: str(a[35]),
              ts: num(a[36]),
              messageId: sid(a[37]),
              fbid: sid(a[39]),
              actionUrl: str(a[65]),
              title: str(a[66]),
              subtitle: str(a[67]),
            })
          );
          break;
        case 'insertXmaAttachment':
          ev.attachments.push(
            attachment('xma', {
              filename: str(a[1]),
              playableUrl: str(a[4]),
              playableMime: str(a[7]),
              previewUrl: str(a[8]),
              previewMime: str(a[11]),
              width: num(a[13]),
              height: num(a[14]),
              threadKey: sid(a[25]),
              type: num(a[27]),
              ts: num(a[29]),
              messageId: sid(a[30]),
              fbid: sid(a[32]),
              actionUrl: str(a[57]),
              title: str(a[58]),
              subtitle: str(a[59]),
            })
          );
          break;
        case 'insertStickerAttachment':
          ev.attachments.push(
            attachment('sticker', {
              playableUrl: str(a[0]),
              previewUrl: str(a[4]) || str(a[20]),
              width: num(a[9]),
              height: num(a[10]),
              threadKey: sid(a[14]),
              ts: num(a[17]),
              messageId: sid(a[18]),
              fbid: sid(a[19]),
              type: 1,
              title: str(a[13]),
            })
          );
          break;
        case 'verifyContactRowExists':
          if (sid(a[0])) ev.contacts.push({ id: sid(a[0]), pic: str(a[2]), name: str(a[3]), isSelf: a[13] === true });
          break;
        case 'deleteThenInsertContact':
          if (sid(a[0])) ev.contacts.push({ id: sid(a[0]), pic: str(a[2]), name: str(a[9]) });
          break;
        case 'deleteThenInsertThread':
          if (sid(a[7]))
            ev.threads.push({
              threadKey: sid(a[7]),
              lastActivity: num(a[0]),
              readWatermark: num(a[1]),
              snippet: str(a[2]),
              name: str(a[3]),
              pic: str(a[4]),
              type: num(a[9]),
              snippetSenderId: sid(a[18]),
            });
          break;
        case 'syncUpdateThreadName':
          if (sid(a[1])) ev.threads.push({ threadKey: sid(a[1]), name: str(a[0]) });
          break;
        case 'updateThreadSnippet':
          if (sid(a[0])) ev.snippets.push({ threadKey: sid(a[0]), snippet: str(a[1]), senderId: sid(a[3]) });
          break;
        case 'upsertReaction':
          if (sid(a[2])) ev.reactions.push({ threadKey: sid(a[0]), ts: num(a[1]), messageId: sid(a[2]), actorId: sid(a[3]), reaction: str(a[4]) });
          break;
        case 'deleteReaction':
          if (sid(a[1])) ev.reactions.push({ threadKey: sid(a[0]), messageId: sid(a[1]), actorId: sid(a[2]), reaction: '', removed: true });
          break;
        case 'markThreadRead':
          if (sid(a[1])) ev.readWatermarks.push({ threadKey: sid(a[1]), ts: num(a[0]) });
          break;
        case 'markThreadReadV2':
          if (sid(a[0])) ev.readWatermarks.push({ threadKey: sid(a[0]), ts: num(a[1]) });
          break;
        case 'updateReadReceipt':
          if (sid(a[1])) ev.receipts.push({ ts: num(a[0]), threadKey: sid(a[1]), contactId: sid(a[2]), actionTs: num(a[3]) });
          break;
        default:
          break;
      }
    }
    return ev;
  }

  /** Full pipeline: any parsed JSON value -> saver events. */
  function eventsFromJson(value, ev) {
    ev = ev || emptyEvents();
    for (const program of findLsSteps(value)) extractEvents(lsCollectCalls(program), ev);
    return ev;
  }

  /** Cheap pre-check before paying for JSON.parse. */
  function mayContainSteps(text) {
    return typeof text === 'string' && (text.indexOf('"step"') !== -1 || text.indexOf('\\"step\\"') !== -1);
  }

  function eventsFromText(text, ev) {
    ev = ev || emptyEvents();
    if (!mayContainSteps(text)) return ev;
    for (const doc of parseJsonDocuments(text)) eventsFromJson(doc, ev);
    return ev;
  }

  /* ------------------------------------------------------------------ */
  /* Unseen: neutralise outgoing "Seen" and "typing" tasks               */
  /* ------------------------------------------------------------------ */
  // Outgoing request envelope (socket.go SocketLSRequestPayload):
  //   {"app_id":"...","payload":"<json>","request_id":N,"type":3|4}
  // type 3 payload: {"epoch_id":..,"tasks":[{"failure_count":null,"label":"21",
  //   "payload":"{\"thread_id\":..,\"last_read_watermark_ts\":..,\"sync_group\":1}",
  //   "queue_name":"<thread id>","task_id":N}],"version_id":".."}
  // type 4 (stateless) payload: {"label":"3","payload":"{\"thread_key\":..,
  //   \"is_typing\":1,...}","version":".."}
  //
  // Tasks are never removed: a mark-read task shares its queue with "send message"
  // tasks of the same chat, so dropping it could stall sending. Instead the task is
  // kept and its read watermark is rewound to what the server already has (no new
  // "Seen"), and typing tasks are rewritten to "not typing".

  const LABEL_MARK_READ = '21';
  const LABEL_TYPING = '3';

  function isMarkReadTask(label, payloadText) {
    return label === LABEL_MARK_READ || (typeof payloadText === 'string' && payloadText.indexOf('last_read_watermark_ts') !== -1);
  }

  function isTypingTask(label, payloadText) {
    return typeof payloadText === 'string' && payloadText.indexOf('is_typing') !== -1 && (label === LABEL_TYPING || label === '');
  }

  /**
   * Rewrites one task object in place. Returns an action record or null.
   * opts: {blockSeen, blockTyping, readWatermarks: Map<threadId, ts>}
   */
  function rewriteTask(task, opts) {
    if (!task || typeof task !== 'object' || typeof task.payload !== 'string') return null;
    const label = task.label === undefined || task.label === null ? '' : String(task.label);
    if (opts.blockSeen && isMarkReadTask(label, task.payload)) {
      const p = parseExact(task.payload);
      if (!p || typeof p !== 'object') return null;
      const thread = idToString(p.thread_id !== undefined ? p.thread_id : p.thread_key);
      const wanted = idToString(p.last_read_watermark_ts);
      const known = opts.readWatermarks && opts.readWatermarks.get(thread);
      let safe = 0;
      if (typeof known === 'number' && known > 0) {
        if (Number(wanted) <= known) return null; // does not move the read marker: harmless
        safe = known; // rewind to what the server already has
      }
      if (wanted === String(safe)) return null;
      p.last_read_watermark_ts = safe;
      task.payload = stringifyExact(p);
      return { type: 'seen-blocked', thread, from: wanted, to: safe };
    }
    if (opts.blockTyping && isTypingTask(label, task.payload)) {
      const p = parseExact(task.payload);
      if (!p || typeof p !== 'object' || !isTruthyFlag(p.is_typing)) return null;
      p.is_typing = 0;
      task.payload = stringifyExact(p);
      return { type: 'typing-blocked', thread: idToString(p.thread_key !== undefined ? p.thread_key : p.thread_id) };
    }
    return null;
  }

  /**
   * Rewrites an outgoing request envelope (JSON text). Returns {text, actions} when
   * something changed, otherwise null.
   */
  function rewriteRequestText(text, opts) {
    if (typeof text !== 'string' || text.length < 10) return null;
    if (!opts.blockSeen && !opts.blockTyping) return null;
    const interesting =
      (opts.blockSeen && (text.indexOf('last_read_watermark_ts') !== -1 || text.indexOf('\\"label\\":\\"21\\"') !== -1)) ||
      (opts.blockTyping && text.indexOf('is_typing') !== -1);
    if (!interesting) return null;
    const env = parseExact(text);
    if (!env || typeof env !== 'object' || typeof env.payload !== 'string') return null;
    const inner = parseExact(env.payload);
    if (!inner || typeof inner !== 'object') return null;
    const actions = [];
    if (Array.isArray(inner.tasks)) {
      for (const task of inner.tasks) {
        const act = rewriteTask(task, opts);
        if (act) actions.push(act);
      }
    } else if (typeof inner.payload === 'string') {
      const act = rewriteTask(inner, opts); // stateless task envelope
      if (act) actions.push(act);
    }
    if (!actions.length) return null;
    env.payload = stringifyExact(inner);
    return { text: stringifyExact(env), actions };
  }

  /**
   * Rewrites a binary outgoing WebSocket message (DGW or MQTT). Returns
   * {bytes, actions} when changed, otherwise null.
   */
  function rewriteOutgoingBytes(u8, kind, opts) {
    if (!u8 || u8.length > MAX_SCAN_BYTES) return null;
    if (kind === 'dgw') {
      const frames = dgwParse(u8);
      if (!frames) return null;
      let changed = false;
      const actions = [];
      const parts = frames.map((f) => {
        if ((f.type === DGW.DATA || f.type === DGW.EXT_DATA) && f.payload && f.payload[0] === 0x7b) {
          const res = rewriteRequestText(utf8Decode(f.payload), opts);
          if (res) {
            changed = true;
            actions.push(...res.actions);
            return dgwEncodeData(f, utf8Encode(res.text));
          }
        }
        return f.raw;
      });
      return changed ? { bytes: concatBytes(parts), actions } : null;
    }
    if (kind === 'mqtt') {
      const packets = mqttParse(u8);
      if (!packets) return null;
      let changed = false;
      const actions = [];
      const parts = packets.map((p) => {
        if (p.type === 3 && p.payload && p.payload[0] === 0x7b) {
          const res = rewriteRequestText(utf8Decode(p.payload), opts);
          if (res) {
            changed = true;
            actions.push(...res.actions);
            return mqttEncodePublish(p, utf8Encode(res.text));
          }
        }
        return p.raw;
      });
      return changed ? { bytes: concatBytes(parts), actions } : null;
    }
    return null;
  }

  /** Reads incoming binary WebSocket data and returns saver events. */
  function eventsFromIncomingBytes(u8, kind, ev) {
    ev = ev || emptyEvents();
    if (!u8 || u8.length > MAX_SCAN_BYTES) return ev;
    if (kind === 'dgw') {
      const frames = dgwParse(u8);
      if (!frames) return ev;
      for (const f of frames) {
        if ((f.type === DGW.DATA || f.type === DGW.EXT_DATA) && f.payload && f.payload.length && (f.payload[0] === 0x7b || f.payload[0] === 0x5b)) {
          eventsFromText(utf8Decode(f.payload), ev);
        }
      }
      return ev;
    }
    if (kind === 'mqtt') {
      const packets = mqttParse(u8);
      if (!packets) return ev;
      for (const p of packets) {
        if (p.type === 3 && p.payload && p.payload.length && p.payload[0] === 0x7b) eventsFromText(utf8Decode(p.payload), ev);
      }
      return ev;
    }
    return ev;
  }

  function socketKind(url) {
    const u = String(url || '');
    if (/^wss?:\/\/gateway\.(facebook|messenger)\.com\//i.test(u) || /\/ws\/lightspeed/i.test(u)) return 'dgw';
    if (/^wss?:\/\/edge-chat\.(facebook|messenger)\.com\//i.test(u)) return 'mqtt';
    if (/web-chat-e2ee\.(facebook|messenger)\.com/i.test(u)) return 'e2ee';
    return 'other';
  }

  /* ------------------------------------------------------------------ */
  /* Installation inside the page                                        */
  /* ------------------------------------------------------------------ */

  const CHANNEL_OUT = '__mms_page_to_ext__';
  const CHANNEL_IN = '__mms_ext_to_page__';

  function install(win) {
    if (win.__mmsInstalled) return;
    try {
      Object.defineProperty(win, '__mmsInstalled', { value: true, enumerable: false });
    } catch (e) {
      return;
    }

    const doc = win.document;
    const CustomEventCtor = win.CustomEvent;
    const dispatch = win.EventTarget.prototype.dispatchEvent;

    const state = {
      settings: {
        enabled: true,
        captureNetwork: true,
        captureNotifications: true,
        blockSeen: true,
        blockTyping: true,
        stealthFocus: true,
      },
      ready: false,
      owner: null,
      queue: [],
      readWatermarks: new Map(),
      diag: {
        sockets: { dgw: 0, mqtt: 0, e2ee: 0, other: 0 },
        framesIn: 0,
        framesOut: 0,
        lsPrograms: 0,
        messages: 0,
        unsent: 0,
        edits: 0,
        seenBlocked: 0,
        typingBlocked: 0,
        httpPayloads: 0,
        notifications: 0,
        errors: 0,
        lastError: '',
        rawJson: HAS_RAW_JSON,
      },
      diagDirty: false,
    };

    function emit(type, data) {
      let msg;
      try {
        msg = JSON.stringify({ type, data });
      } catch (e) {
        return;
      }
      if (!state.ready) {
        state.queue.push(msg);
        if (state.queue.length > 2000) state.queue.shift();
        return;
      }
      try {
        dispatch.call(doc, new CustomEventCtor(CHANNEL_OUT, { detail: msg }));
      } catch (e) {
        /* ignore */
      }
    }

    function flushQueue() {
      const q = state.queue;
      state.queue = [];
      for (const msg of q) {
        try {
          dispatch.call(doc, new CustomEventCtor(CHANNEL_OUT, { detail: msg }));
        } catch (e) {
          /* ignore */
        }
      }
    }

    function noteError(e) {
      state.diag.errors++;
      state.diag.lastError = String((e && e.message) || e).slice(0, 200);
      state.diagDirty = true;
    }

    doc.addEventListener(CHANNEL_IN, function (e) {
      let m;
      try {
        m = JSON.parse(String(e.detail));
      } catch (err) {
        return;
      }
      if (!m || typeof m !== 'object') return;
      // After an update a newer content-script copy takes over; an older copy's last words
      // (e.g. "disable" from a retired copy) must not override it.
      if (m.inst && typeof m.inst.t === 'number') {
        if (state.owner && m.inst.id !== state.owner.id && m.inst.t < state.owner.t) return;
        if (!state.owner || m.inst.t >= state.owner.t) state.owner = { id: String(m.inst.id), t: m.inst.t };
      }
      if (m.type === 'settings' && m.data && typeof m.data === 'object') {
        Object.assign(state.settings, m.data);
        if (!state.ready) {
          state.ready = true;
          flushQueue();
        }
        emit('diag', state.diag);
      } else if (m.type === 'diag-request') {
        emit('diag', state.diag);
      }
    });

    // If the extension side never answers (e.g. it was disabled), stop buffering.
    win.setTimeout(function () {
      if (!state.ready) state.queue.length = 0;
    }, 60000);

    function active() {
      return state.settings.enabled !== false;
    }

    function handleEvents(ev, source) {
      if (!hasEvents(ev)) return;
      for (const t of ev.threads) if (t.readWatermark) state.readWatermarks.set(t.threadKey, t.readWatermark);
      for (const r of ev.readWatermarks) if (r.ts) state.readWatermarks.set(r.threadKey, r.ts);
      state.diag.messages += ev.messages.length;
      state.diag.unsent += ev.unsent.length;
      state.diag.edits += ev.edits.length;
      state.diagDirty = true;
      if (!active() || state.settings.captureNetwork === false) return;
      ev.source = source;
      emit('ls-events', ev);
    }

    /* ---------------- WebSockets ---------------- */

    const NativeWS = win.WebSocket;
    const socketKinds = new WeakMap();

    function kindOf(ws) {
      let k = socketKinds.get(ws);
      if (!k) {
        k = socketKind(ws && ws.url);
        socketKinds.set(ws, k);
      }
      return k;
    }

    function onIncoming(ws, data) {
      const kind = kindOf(ws);
      if (kind !== 'dgw' && kind !== 'mqtt') return;
      state.diag.framesIn++;
      const handleBytes = (u8) => {
        try {
          const ev = eventsFromIncomingBytes(u8, kind);
          handleEvents(ev, kind);
        } catch (e) {
          noteError(e);
        }
      };
      if (typeof data === 'string') {
        try {
          handleEvents(eventsFromText(data), kind);
        } catch (e) {
          noteError(e);
        }
        return;
      }
      const u8 = asBytes(data);
      if (u8) handleBytes(u8);
      else if (data && typeof data.arrayBuffer === 'function') {
        data.arrayBuffer().then((buf) => handleBytes(new Uint8Array(buf)), noteError);
      }
    }

    function onOutgoing(ws, data) {
      const s = state.settings;
      if (!active() || (!s.blockSeen && !s.blockTyping)) return data;
      const kind = kindOf(ws);
      if (kind !== 'dgw' && kind !== 'mqtt') return data;
      state.diag.framesOut++;
      const opts = { blockSeen: !!s.blockSeen, blockTyping: !!s.blockTyping, readWatermarks: state.readWatermarks };
      if (typeof data === 'string') {
        const res = rewriteRequestText(data, opts);
        if (!res) return data;
        recordActions(res.actions);
        return res.text;
      }
      const u8 = asBytes(data);
      if (!u8) return data; // Blob payloads cannot be rewritten synchronously
      const res = rewriteOutgoingBytes(u8, kind, opts);
      if (!res) return data;
      recordActions(res.actions);
      // keep the caller's type: ArrayBuffer in -> ArrayBuffer out
      if (data instanceof ArrayBuffer) return res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength);
      return res.bytes;
    }

    function recordActions(actions) {
      for (const a of actions) {
        if (a.type === 'seen-blocked') state.diag.seenBlocked++;
        else if (a.type === 'typing-blocked') state.diag.typingBlocked++;
      }
      state.diagDirty = true;
      emit('unseen-actions', actions);
    }

    if (typeof NativeWS === 'function') {
      const proto = NativeWS.prototype;
      const nativeSend = proto.send;
      proto.send = function send(data) {
        let out = data;
        try {
          out = onOutgoing(this, data);
        } catch (e) {
          noteError(e);
          out = data;
        }
        return nativeSend.call(this, out);
      };
      win.WebSocket = new Proxy(NativeWS, {
        construct(target, args, newTarget) {
          const ws = Reflect.construct(target, args, newTarget);
          try {
            const kind = socketKind(args[0]);
            socketKinds.set(ws, kind);
            state.diag.sockets[kind] = (state.diag.sockets[kind] || 0) + 1;
            state.diagDirty = true;
            if (kind === 'dgw' || kind === 'mqtt') {
              ws.addEventListener('message', function (ev) {
                onIncoming(ws, ev.data);
              });
            }
          } catch (e) {
            noteError(e);
          }
          return ws;
        },
      });
    }

    /* ---------------- HTTP (GraphQL) replies ---------------- */

    // Only Messenger requests are read; the busy news feed is left alone.
    const MESSENGER_HINT = /lightspeed|LSPlatform|messenger|messaging|MAW|inbox|thread/i;

    function interestingUrl(url) {
      const u = String(url || '');
      if (/lightspeed|\/messaging\/|\/messages\//i.test(u)) return 'yes';
      return /\/api\/graphql|\/ajax\//i.test(u) ? 'maybe' : '';
    }

    /** Looks at a GraphQL request body for Messenger's query names. */
    function bodyLooksMessenger(body) {
      try {
        if (!body) return false;
        if (typeof body === 'string') return MESSENGER_HINT.test(body.slice(0, 4000));
        if (body instanceof win.URLSearchParams) return MESSENGER_HINT.test(body.get('fb_api_req_friendly_name') || body.toString().slice(0, 4000));
        if (body instanceof win.FormData) return MESSENGER_HINT.test(String(body.get('fb_api_req_friendly_name') || ''));
      } catch (e) {
        /* unreadable body */
      }
      return false;
    }

    function headerLooksMessenger(headers) {
      try {
        if (!headers) return false;
        const get = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k] || headers[k.toLowerCase()]);
        return MESSENGER_HINT.test(String(get('X-FB-Friendly-Name') || get('x-fb-friendly-name') || ''));
      } catch (e) {
        return false;
      }
    }

    function handleHttpText(text) {
      if (!active() || state.settings.captureNetwork === false) return;
      if (!mayContainSteps(text)) return;
      state.diag.httpPayloads++;
      try {
        handleEvents(eventsFromText(text), 'http');
      } catch (e) {
        noteError(e);
      }
    }

    const nativeFetch = win.fetch;
    if (typeof nativeFetch === 'function') {
      win.fetch = new Proxy(nativeFetch, {
        apply(target, thisArg, args) {
          const p = Reflect.apply(target, thisArg, args);
          try {
            const req = args[0];
            const init = args[1] || {};
            const url = typeof req === 'string' ? req : req && req.url;
            const kind = interestingUrl(url);
            const wanted = kind === 'yes' || (kind === 'maybe' && (bodyLooksMessenger(init.body) || headerLooksMessenger(init.headers) || headerLooksMessenger(req && req.headers)));
            if (wanted && p && typeof p.then === 'function') {
              p.then(
                (resp) => {
                  try {
                    const ct = (resp.headers && resp.headers.get('content-type')) || '';
                    if (/json|javascript|text/i.test(ct) || !ct) resp.clone().text().then(handleHttpText, () => {});
                  } catch (e) {
                    /* ignore */
                  }
                },
                () => {}
              );
            }
          } catch (e) {
            noteError(e);
          }
          return p;
        },
      });
    }

    const XHR = win.XMLHttpRequest;
    if (typeof XHR === 'function') {
      const xopen = XHR.prototype.open;
      const xsend = XHR.prototype.send;
      const xhrUrls = new WeakMap();
      XHR.prototype.open = function open(method, url) {
        try {
          xhrUrls.set(this, String(url));
        } catch (e) {
          /* ignore */
        }
        return xopen.apply(this, arguments);
      };
      XHR.prototype.send = function send(body) {
        try {
          const url = xhrUrls.get(this);
          const kind = interestingUrl(url);
          if (kind === 'yes' || (kind === 'maybe' && bodyLooksMessenger(body))) {
            this.addEventListener('load', function () {
              try {
                if (this.responseType === '' || this.responseType === 'text') handleHttpText(this.responseText);
              } catch (e) {
                /* ignore */
              }
            });
          }
        } catch (e) {
          noteError(e);
        }
        return xsend.apply(this, arguments);
      };
    }

    /* ---------------- Data embedded in the initial HTML ---------------- */

    const scannedScripts = new WeakSet();
    function scanScript(el) {
      if (scannedScripts.has(el)) return;
      scannedScripts.add(el);
      const type = el.getAttribute('type') || '';
      if (type !== 'application/json') return;
      const text = el.textContent || '';
      if (text.length < 20 || !mayContainSteps(text)) return;
      handleHttpText(text);
    }
    try {
      const mo = new win.MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 && n.tagName === 'SCRIPT') scanScript(n);
          }
        }
      });
      mo.observe(doc, { childList: true, subtree: true });
      win.addEventListener('load', () => {
        try {
          doc.querySelectorAll('script[type="application/json"]').forEach(scanScript);
        } catch (e) {
          /* ignore */
        }
        win.setTimeout(() => mo.disconnect(), 30000);
      });
    } catch (e) {
      noteError(e);
    }

    /* ---------------- Notifications (backup copy of message text) ---------------- */

    function noteNotification(title, options) {
      if (!active() || state.settings.captureNotifications === false) return;
      const body = options && typeof options.body === 'string' ? options.body : '';
      if (!body && !title) return;
      state.diag.notifications++;
      state.diagDirty = true;
      emit('notification', {
        title: String(title || '').slice(0, 300),
        body: body.slice(0, 5000),
        tag: options && options.tag ? String(options.tag).slice(0, 300) : '',
        ts: Date.now(),
      });
    }

    const NativeNotification = win.Notification;
    if (typeof NativeNotification === 'function') {
      win.Notification = new Proxy(NativeNotification, {
        construct(target, args, newTarget) {
          try {
            noteNotification(args[0], args[1]);
          } catch (e) {
            noteError(e);
          }
          return Reflect.construct(target, args, newTarget);
        },
      });
    }
    if (win.ServiceWorkerRegistration && win.ServiceWorkerRegistration.prototype.showNotification) {
      const nativeShow = win.ServiceWorkerRegistration.prototype.showNotification;
      win.ServiceWorkerRegistration.prototype.showNotification = function showNotification(title, options) {
        try {
          noteNotification(title, options);
        } catch (e) {
          noteError(e);
        }
        return nativeShow.apply(this, arguments);
      };
    }

    /* ---------------- Stealth focus: page always looks "in the background" ---------------- */
    // Messenger only marks a chat as read while the tab is visible and focused. Faking
    // "hidden + unfocused" stops "Seen" in encrypted chats too, where the network
    // traffic itself cannot be read or changed.

    function stealth() {
      const s = state.settings;
      return active() && !!s.blockSeen && !!s.stealthFocus;
    }

    try {
      const DocProto = win.Document.prototype;
      const nativeHasFocus = DocProto.hasFocus;
      DocProto.hasFocus = function hasFocus() {
        return stealth() ? false : nativeHasFocus.call(this);
      };
      const patchGetter = (name, fakeValue) => {
        const desc = Object.getOwnPropertyDescriptor(DocProto, name);
        if (!desc || typeof desc.get !== 'function') return;
        Object.defineProperty(DocProto, name, {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () {
            return stealth() ? fakeValue : desc.get.call(this);
          },
        });
      };
      patchGetter('visibilityState', 'hidden');
      patchGetter('hidden', true);
      patchGetter('webkitVisibilityState', 'hidden');
      patchGetter('webkitHidden', true);
      const swallow = function (e) {
        if (stealth() && (e.target === win || e.target === doc)) e.stopImmediatePropagation();
      };
      win.addEventListener('focus', swallow, true);
      doc.addEventListener('visibilitychange', swallow, true);
      doc.addEventListener('webkitvisibilitychange', swallow, true);
    } catch (e) {
      noteError(e);
    }

    /* ---------------- periodic diagnostics ---------------- */
    win.setInterval(function () {
      if (state.diagDirty && state.ready) {
        state.diagDirty = false;
        emit('diag', state.diag);
      }
    }, 5000);
  }

  const api = {
    DGW,
    dgwParse,
    dgwEncodeData,
    mqttParse,
    mqttEncodePublish,
    findLsSteps,
    lsCollectCalls,
    extractEvents,
    eventsFromJson,
    eventsFromText,
    eventsFromIncomingBytes,
    rewriteRequestText,
    rewriteOutgoingBytes,
    parseJsonDocuments,
    parseExact,
    socketKind,
    emptyEvents,
    hasEvents,
    CHANNEL_OUT,
    CHANNEL_IN,
  };

  if (typeof window === 'undefined' && typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  install(root);
})(typeof globalThis !== 'undefined' ? globalThis : this);
