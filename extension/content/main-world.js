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
  // The web client marks a chat read with two tasks: label "21" (thread_id,
  // last_read_watermark_ts) and label "49" (thread_key, last_read_watermark_timestamp_ms).
  // type 4 (stateless) payload: {"label":"3","payload":"{\"thread_key\":..,
  //   \"is_typing\":1,...}","version":".."}
  //
  // Rules for "Seen":
  //  - a task is never removed (it shares its queue with "send message" tasks);
  //  - a read marker is only ever moved back to the value the server already has for that
  //    chat, so nothing new is reported and nothing is marked unread;
  //  - when that value is not known yet, the task is left alone (a lower value would mark
  //    the chat unread on all devices) and reported as 'seen-unknown';
  //  - a task that does not move the marker forward (e.g. "Mark as unread") is left alone.

  const READ_LABELS = new Set(['21', '49']);
  const READ_KEYS = ['last_read_watermark_ts', 'last_read_watermark_timestamp_ms'];
  const LABEL_TYPING = '3';

  function ownKey(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * Looks at one task (rewriting it in place when needed).
   * Returns null, or {action, changed}. opts: {blockSeen, blockTyping, readWatermarks}
   */
  function rewriteTask(task, opts) {
    if (!task || typeof task !== 'object' || typeof task.payload !== 'string') return null;
    const label = task.label === undefined || task.label === null ? '' : String(task.label);
    if ((opts.blockSeen || opts.learn) && READ_LABELS.has(label)) {
      const p = parseExact(task.payload);
      if (!p || typeof p !== 'object') return null;
      const key = READ_KEYS.find((k) => ownKey(p, k));
      if (!key) return null;
      const thread = idToString(ownKey(p, 'thread_id') ? p.thread_id : p.thread_key);
      const wanted = Number(idToString(p[key]));
      // a read marker that goes out unchanged becomes the server's value: remember it
      const sent = { type: 'seen-sent', thread, value: wanted };
      if (!opts.blockSeen) return { action: sent, changed: false };
      const known = opts.readWatermarks && opts.readWatermarks.get(thread);
      if (typeof known !== 'number' || !(known > 0)) return { action: { type: 'seen-unknown', thread, label, value: wanted }, changed: false };
      if (!(wanted > known)) return { action: sent, changed: false }; // not moving the marker forward: leave it
      p[key] = known;
      task.payload = stringifyExact(p);
      return { action: { type: 'seen-blocked', thread, label, from: String(wanted), to: known }, changed: true };
    }
    if (opts.blockTyping && label === LABEL_TYPING) {
      const p = parseExact(task.payload);
      if (!p || typeof p !== 'object' || !ownKey(p, 'is_typing') || !isTruthyFlag(p.is_typing)) return null;
      p.is_typing = 0;
      task.payload = stringifyExact(p);
      return { action: { type: 'typing-blocked', thread: idToString(ownKey(p, 'thread_key') ? p.thread_key : p.thread_id) }, changed: true };
    }
    return null;
  }

  /**
   * Looks at an outgoing request envelope (JSON text). Returns null when it is not of
   * interest, otherwise {text, actions} where text is the rewritten request, or null when
   * the request must go out unchanged.
   */
  function rewriteRequestText(text, opts) {
    if (typeof text !== 'string' || text.length < 10) return null;
    if (!opts.blockSeen && !opts.blockTyping && !opts.learn) return null;
    const interesting = ((opts.blockSeen || opts.learn) && text.indexOf('last_read_watermark') !== -1) || (opts.blockTyping && text.indexOf('is_typing') !== -1);
    if (!interesting) return null;
    const env = parseExact(text);
    if (!env || typeof env !== 'object' || typeof env.payload !== 'string') return null;
    const inner = parseExact(env.payload);
    if (!inner || typeof inner !== 'object') return null;
    const actions = [];
    let changed = false;
    const look = (task) => {
      const r = rewriteTask(task, opts);
      if (!r) return;
      actions.push(r.action);
      if (r.changed) changed = true;
    };
    if (Array.isArray(inner.tasks)) inner.tasks.forEach(look);
    else if (typeof inner.payload === 'string') look(inner); // stateless task envelope
    if (!actions.length) return null;
    if (!changed) return { text: null, actions };
    env.payload = stringifyExact(inner);
    return { text: stringifyExact(env), actions };
  }

  /**
   * Looks at a binary outgoing WebSocket message (DGW or MQTT). Returns null, or
   * {bytes, actions} where bytes is null when the message must go out unchanged.
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
            actions.push(...res.actions);
            if (res.text !== null) {
              changed = true;
              return dgwEncodeData(f, utf8Encode(res.text));
            }
          }
        }
        return f.raw;
      });
      if (!actions.length) return null;
      return { bytes: changed ? concatBytes(parts) : null, actions };
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
            actions.push(...res.actions);
            if (res.text !== null) {
              changed = true;
              return mqttEncodePublish(p, utf8Encode(res.text));
            }
          }
        }
        return p.raw;
      });
      if (!actions.length) return null;
      return { bytes: changed ? concatBytes(parts) : null, actions };
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
  /* Downloads: a video's file, a photo's largest copy                   */
  /* ------------------------------------------------------------------ */
  // Facebook plays videos and reels through MediaSource ("blob:" addresses that cannot be
  // saved), but its data for every video also carries ready-made MP4 files with sound:
  //   videoDeliveryLegacyFields: browser_native_hd_url / browser_native_sd_url,
  //                              playable_url_quality_hd / playable_url
  //   videoDeliveryResponseResult.progressive_urls[]: { progressive_url, metadata.quality }
  //   older pages / player props: hd_src / sd_src, hdSrc / sdSrc
  // and DASH manifests (separate picture and sound tracks) as the last resort.
  // Field names checked against yt-dlp's Facebook extractor (Nov 2026).

  const HD_KEYS = ['browser_native_hd_url', 'playable_url_quality_hd', 'hd_src_no_ratelimit', 'hd_src', 'hdSrcNoRatelimit', 'hdSrc', 'browserNativeHdUrl', 'playableUrlQualityHd', 'hdPlaybackUrl'];
  const SD_KEYS = ['browser_native_sd_url', 'playable_url', 'sd_src_no_ratelimit', 'sd_src', 'sdSrcNoRatelimit', 'sdSrc', 'browserNativeSdUrl', 'playableUrl', 'sdPlaybackUrl'];
  const DASH_KEYS = ['manifest_xml', 'dash_manifest', 'dash_manifest_xml_string', 'manifestXml', 'dashManifest', 'dashManifestXml'];
  const VIDEO_ID_KEYS = ['videoId', 'videoID', 'video_id', 'videoFBID', 'videoFbid'];
  const WALK_SKIP = new Set(['_owner', '_debugOwner', 'return', 'child', 'sibling', 'alternate', 'stateNode', 'ref', 'environment', 'relayEnvironment', '__fragmentOwner', '__fragments', 'dispatch']);

  function isFbMediaUrl(u) {
    return typeof u === 'string' && u.length < 4000 && /^https:\/\/[a-z0-9.-]+\.(?:fbcdn\.net|fbsbx\.com|facebook\.com)\//i.test(u);
  }

  /** A whole MP4 file on Facebook's media servers (not a manifest, not one byte range of a DASH track). */
  function isProgressiveUrl(u) {
    return isFbMediaUrl(u) && /^https:\/\/[^/]+\.(?:fbcdn\.net|fbsbx\.com)\//i.test(u) && !/[?&](?:bytestart|byteend)=/i.test(u) && !/\.mpd(?:[?#]|$)/i.test(u);
  }

  function looksLikeMpd(s) {
    return typeof s === 'string' && s.length > 40 && /^\s*(?:<\?xml|<MPD|%3C%3Fxml|%3CMPD)/i.test(s);
  }

  function numericId(v) {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
    return /^\d{5,25}$/.test(s) ? s : '';
  }

  /**
   * Walks plain objects and arrays (React props, hook state, parsed page JSON), never class
   * instances, DOM nodes or React's fiber links. visit(obj, ctx) returns the context for the
   * object's children (or WALK_STOP).
   */
  const WALK_STOP = {};
  function walkPlain(root, visit, budget, maxDepth, ctx0, total) {
    const seen = new Set();
    const stack = [[root, 0, ctx0 || '']];
    let n = 0;
    while (stack.length && n < budget) {
      if (total && total.n >= total.max) return; // shared cap for one whole search
      const [v, depth, ctx] = stack.pop();
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      n++;
      if (total) total.n++;
      try {
        if (Array.isArray(v)) {
          if (depth >= maxDepth) continue;
          for (let i = Math.min(v.length, 400) - 1; i >= 0; i--) {
            const c = v[i];
            if (c && typeof c === 'object') stack.push([c, depth + 1, ctx]);
          }
          continue;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) continue;
        const ctx2 = visit(v, ctx);
        if (ctx2 === WALK_STOP) return;
        if (depth >= maxDepth) continue;
        const keys = Object.keys(v);
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i];
          if (WALK_SKIP.has(k) || k.startsWith('__react')) continue;
          const c = v[k];
          if (c && typeof c === 'object') stack.push([c, depth + 1, ctx2]);
        }
      } catch (e) {
        /* a getter that throws: skip this object */
      }
    }
  }

  function firstUrl(o, keys, test) {
    for (const k of keys) {
      const u = o[k];
      if (test(u)) return u;
    }
    return '';
  }

  /** Video files described by one object (or '' parts), with the id the object carries. */
  function videoPartsOf(o) {
    let hd = firstUrl(o, HD_KEYS, isProgressiveUrl);
    let sd = firstUrl(o, SD_KEYS, isProgressiveUrl);
    const prog = o.progressive_urls || o.progressiveUrls;
    if (Array.isArray(prog)) {
      for (const p of prog) {
        if (!p || typeof p !== 'object') continue;
        const u = p.progressive_url || p.progressiveUrl;
        if (!isProgressiveUrl(u)) continue;
        const q = String((p.metadata && p.metadata.quality) || p.quality || '').toLowerCase();
        if (q === 'hd' && !hd) hd = u;
        else if (q !== 'hd' && !sd) sd = u;
      }
    }
    let dash = '';
    for (const k of DASH_KEYS) {
      if (looksLikeMpd(o[k])) {
        dash = o[k];
        break;
      }
    }
    if (!hd && !sd && !dash) return null;
    return { hd, sd, dash };
  }

  function ownVideoId(o, hasMedia) {
    for (const k of VIDEO_ID_KEYS) {
      const id = numericId(o[k]);
      if (id) return id;
    }
    if (o.__typename === 'Video' || hasMedia) return numericId(o.id);
    return '';
  }

  /**
   * Every video found under `root`, merged per video id, in the order met.
   * Returns [{ id, hd, sd, dash }].
   */
  function findVideoSources(root, opts) {
    const o = opts || {};
    const byKey = new Map();
    let anon = 0;
    walkPlain(
      root,
      (obj, ctx) => {
        const parts = videoPartsOf(obj);
        const id = ownVideoId(obj, !!parts) || ctx;
        if (parts) {
          const key = id || 'anon' + anon++;
          const cur = byKey.get(key) || { id, hd: '', sd: '', dash: '' };
          cur.hd = cur.hd || parts.hd;
          cur.sd = cur.sd || parts.sd;
          cur.dash = cur.dash || parts.dash;
          byKey.set(key, cur);
        }
        return id;
      },
      o.budget || 3000,
      o.maxDepth || 10,
      o.ctxId || '',
      o.total
    );
    return [...byKey.values()];
  }

  function pickVideo(list, id) {
    if (!list || !list.length) return null;
    if (id) {
      const exact = list.find((v) => v.id === id);
      if (exact) return exact;
    }
    return list.find((v) => v.hd || v.sd) || list[0];
  }

  /** The best picture track and the best sound track of a DASH manifest. */
  function dashTracks(xml) {
    let s = String(xml || '');
    if (/^\s*%3C/i.test(s)) {
      try {
        s = decodeURIComponent(s.replace(/\+/g, ' '));
      } catch (e) {
        return null;
      }
    }
    const unescapeXml = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    const attr = (tag, name) => {
      const m = new RegExp('\\s' + name + '="([^"]*)"', 'i').exec(tag);
      return m ? m[1] : '';
    };
    let video = null;
    let audio = null;
    const setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let set;
    while ((set = setRe.exec(s))) {
      const setAttrs = set[1];
      const repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
      let rep;
      while ((rep = repRe.exec(set[2]))) {
        const repAttrs = rep[1];
        const base = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/i.exec(rep[2]);
        if (!base) continue;
        const url = unescapeXml(base[1].trim());
        if (!isFbMediaUrl(url)) continue;
        const type = (attr(repAttrs, 'mimeType') || attr(setAttrs, 'mimeType') || attr(setAttrs, 'contentType') || '').toLowerCase();
        const bw = Number(attr(repAttrs, 'bandwidth')) || 0;
        const h = Number(attr(repAttrs, 'height')) || 0;
        if (type.indexOf('video') !== -1) {
          if (!video || h > video.height || (h === video.height && bw > video.bandwidth)) video = { url, height: h, bandwidth: bw };
        } else if (type.indexOf('audio') !== -1) {
          if (!audio || bw > audio.bandwidth) audio = { url, bandwidth: bw };
        }
      }
    }
    if (!video && !audio) return null;
    return { video: video ? video.url : '', height: video ? video.height : 0, audio: audio ? audio.url : '' };
  }

  /** Video id in a Facebook address: /reel/ID, /watch/?v=ID, /videos/ID, video.php?v=ID. */
  function videoIdFromUrl(href) {
    const s = String(href || '');
    if (!/facebook\.com|^\//i.test(s)) return '';
    const m = /\/reels?\/(\d{5,25})/.exec(s) || /\/watch\/?(?:live\/?)?\?(?:[^#]*&)?v=(\d{5,25})/.exec(s) || /\/video\.php\?(?:[^#]*&)?v=(\d{5,25})/.exec(s) || /\/videos\/(?:[^/?#]+\/)*?(\d{5,25})(?:[/?#]|$)/.exec(s);
    return m ? m[1] : '';
  }

  /** Picks the JSON blocks of a page's HTML that mention a video file, parsed. */
  function videoJsonFromHtml(html) {
    const out = [];
    const re = /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(String(html || '')))) {
      const text = m[1];
      if (!/progressive_url|browser_native_(?:hd|sd)_url|playable_url|"hd_src|"sd_src|manifest_xml|dash_manifest/.test(text)) continue;
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        /* not JSON */
      }
    }
    return out;
  }

  /** The file name of a Facebook photo, the same at every size (only ?stp= changes). */
  function imageFileKey(u) {
    const m = /\/([^/?#]+\.(?:jpe?g|png|webp|gif|heic|avif))(?:[?#]|$)/i.exec(String(u || ''));
    return m ? m[1].toLowerCase() : '';
  }

  /** Width x height asked of Facebook's image server in ?stp=..._s960x960_... (0 = not stated). */
  function stpArea(u) {
    const m = /[?&]stp=[^&]*?(?:^|[_=-])[sp](\d{2,5})x(\d{2,5})/i.exec(String(u || ''));
    return m ? Number(m[1]) * Number(m[2]) : 0;
  }

  /** Copies of the same photo (same file name) under `root`, with their size where known. */
  function findImageCopies(root, key, opts) {
    const o = opts || {};
    const found = [];
    if (!key) return found;
    walkPlain(
      root,
      (obj) => {
        for (const k of Object.keys(obj)) {
          const u = obj[k];
          if (typeof u !== 'string' || !isFbMediaUrl(u) || imageFileKey(u) !== key) continue;
          const base = k.replace(/(?:_?ur[il]|_?src)$/i, '');
          const w = Number(obj[base + 'Width'] || obj[base + '_width'] || obj.width) || 0;
          const h = Number(obj[base + 'Height'] || obj[base + '_height'] || obj.height) || 0;
          found.push({ url: u, area: w > 0 && h > 0 ? w * h : stpArea(u) });
        }
        return '';
      },
      o.budget || 2000,
      o.maxDepth || 8,
      '',
      o.total
    );
    return found;
  }

  function bestImage(displayed, copies) {
    let best = { url: displayed, area: stpArea(displayed) };
    for (const c of copies || []) if (c.area > best.area) best = c;
    return best.url;
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
    const lateInjected = doc.readyState !== 'loading';
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
        stealthVisibility: false,
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
        seenUnknown: 0, // "Seen" that could not be held back (chat's read marker not known yet)
        typingBlocked: 0,
        lateInjected, // hook added after the page had started (after an install/update)
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
        if (typeof state.syncStealth === 'function') state.syncStealth();
        if (!state.ready) {
          state.ready = true;
          flushQueue();
        }
        emit('diag', state.diag);
      } else if (m.type === 'media-resolve' && m.data && typeof m.data === 'object') {
        const reqId = String(m.data.reqId || '');
        if (typeof state.resolveMedia !== 'function' || !reqId) return;
        state
          .resolveMedia(m.data)
          .then(
            (result) => emit('media-result', { reqId, result }),
            (err) => emit('media-result', { reqId, error: String((err && err.message) || err).slice(0, 200) })
          );
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
        // a socket opened before this hook was added: start reading it now
        k = socketKind(ws && ws.url);
        socketKinds.set(ws, k);
        state.diag.sockets[k] = (state.diag.sockets[k] || 0) + 1;
        if (k === 'dgw' || k === 'mqtt') {
          try {
            ws.addEventListener('message', function (ev) {
              onIncoming(ws, ev.data);
            });
          } catch (e) {
            noteError(e);
          }
        }
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
      const kind = kindOf(ws);
      if (kind !== 'dgw' && kind !== 'mqtt') return data;
      state.diag.framesOut++;
      // with the extension paused or Unseen off nothing is changed, but read markers that
      // go out are still noted, so turning Unseen back on never rewinds below them
      const on = active();
      const opts = { blockSeen: on && !!s.blockSeen, blockTyping: on && !!s.blockTyping, learn: true, readWatermarks: state.readWatermarks };
      if (typeof data === 'string') {
        const res = rewriteRequestText(data, opts);
        if (!res) return data;
        recordActions(res.actions);
        return res.text === null ? data : res.text;
      }
      const u8 = asBytes(data);
      if (!u8) return data; // Blob payloads cannot be rewritten synchronously
      const res = rewriteOutgoingBytes(u8, kind, opts);
      if (!res) return data;
      recordActions(res.actions);
      if (!res.bytes) return data;
      // keep the caller's type: ArrayBuffer in -> ArrayBuffer out
      if (data instanceof ArrayBuffer) return res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength);
      return res.bytes;
    }

    function recordActions(actions) {
      const report = [];
      for (const a of actions) {
        if ((a.type === 'seen-sent' || a.type === 'seen-unknown') && a.thread && a.value > 0) {
          const known = state.readWatermarks.get(a.thread) || 0;
          if (a.value > known) state.readWatermarks.set(a.thread, a.value);
        }
        if (a.type === 'seen-sent') continue; // bookkeeping only
        if (a.type === 'seen-blocked') state.diag.seenBlocked++;
        else if (a.type === 'typing-blocked') state.diag.typingBlocked++;
        else if (a.type === 'seen-unknown') state.diag.seenUnknown++;
        report.push(a);
      }
      if (!report.length) return;
      state.diagDirty = true;
      emit('unseen-actions', report);
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

    // Only Messenger requests are read; the busy news feed is left alone. A GraphQL request
    // counts as Messenger's only by its query name (fb_api_req_friendly_name), never by
    // scanning the whole body: Facebook's long random request fields (__dyn, __csr) could
    // match a short word by chance and make the feed's replies get copied for nothing.
    const MESSENGER_HINT = /lightspeed|LSPlatform|messenger|messaging|MAW|inbox|thread/i;

    function interestingUrl(url) {
      const u = String(url || '');
      if (/lightspeed|\/messaging\//i.test(u)) return 'yes';
      return /\/api\/graphql|\/ajax\//i.test(u) ? 'maybe' : '';
    }

    function friendlyNameOf(body) {
      if (!body) return '';
      if (typeof body === 'string') {
        const m = /(?:^|&)fb_api_req_friendly_name=([^&]{1,200})/.exec(body);
        if (!m) return '';
        try {
          return decodeURIComponent(m[1].replace(/\+/g, ' '));
        } catch (e) {
          return m[1];
        }
      }
      if (body instanceof win.URLSearchParams || body instanceof win.FormData) return String(body.get('fb_api_req_friendly_name') || '');
      return '';
    }

    /** Looks at a GraphQL request's query name for Messenger's queries. */
    function bodyLooksMessenger(body) {
      try {
        const name = friendlyNameOf(body);
        return !!name && MESSENGER_HINT.test(name);
      } catch (e) {
        return false; // unreadable body
      }
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

    /* ---------------- Strong mode: the page looks unfocused ---------------- */
    // Messenger marks a chat as read only while the window has focus. Reporting "no focus"
    // keeps it from sending "Seen" in encrypted chats too, where the traffic cannot be read.
    // The page's visibility stays real (Facebook needs it to recover its encrypted-chat
    // engine when several tabs are open); faking "hidden" as well is a separate, off-by-
    // default option, and visibilitychange events are never blocked.
    //
    // Only on Messenger's own pages (facebook.com/messages/..., messenger.com). Facebook's
    // whole site shares one "is the user on this tab" flag (its UserActivity module, set
    // from document.hasFocus() and window focus/blur events); with "no focus" everywhere the
    // news feed, Watch and Reels treat the user as away and stop loading (the feed stays on
    // grey placeholder cards). Facebook is a single-page app, so the route is checked on
    // every navigation, and the flag is handed back with a window "focus" event on leaving
    // Messenger (and taken away with a "blur" event on entering it).

    function onMessengerRoute() {
      try {
        const loc = win.location;
        if (/(^|\.)messenger\.com$/i.test(String(loc.hostname || ''))) return true;
        return /^\/messages(?:\/|$)/i.test(String(loc.pathname || ''));
      } catch (e) {
        return false;
      }
    }

    function stealthFocus() {
      const s = state.settings;
      return active() && !!s.blockSeen && !!s.stealthFocus && onMessengerRoute();
    }

    function stealthHidden() {
      return stealthFocus() && !!state.settings.stealthVisibility;
    }

    let nativeHasFocus = null;
    let nativeVisibility = null;
    let stealthWas = false;
    let hiddenWas = false;

    /**
     * Called after a navigation or a settings change: tells Facebook when the focus flag (and,
     * with the extra option, the fake "hidden" state) changes, exactly as a real window
     * blur/focus or tab switch would.
     */
    function syncStealth() {
      let now;
      let hiddenNow;
      try {
        now = stealthFocus();
        hiddenNow = stealthHidden();
      } catch (e) {
        return;
      }
      if (now !== stealthWas) {
        stealthWas = now;
        state.diag.strongMode = now;
        state.diagDirty = true;
        let realFocus = false;
        try {
          realFocus = !!(nativeHasFocus && nativeHasFocus.call(doc));
        } catch (e) {
          realFocus = false;
        }
        // a window without real focus already counts as "away" for Facebook: nothing to tell
        if (realFocus) {
          try {
            const Ctor = typeof win.FocusEvent === 'function' ? win.FocusEvent : win.Event;
            dispatch.call(win, new Ctor(now ? 'blur' : 'focus'));
          } catch (e) {
            noteError(e);
          }
        }
      }
      if (hiddenNow !== hiddenWas) {
        hiddenWas = hiddenNow;
        let reallyVisible = true;
        try {
          reallyVisible = !nativeVisibility || nativeVisibility.call(doc) === 'visible';
        } catch (e) {
          reallyVisible = true;
        }
        if (reallyVisible) {
          try {
            dispatch.call(doc, new win.Event('visibilitychange'));
          } catch (e) {
            noteError(e);
          }
        }
      }
    }
    state.syncStealth = syncStealth;

    try {
      const DocProto = win.Document.prototype;
      nativeHasFocus = DocProto.hasFocus;
      DocProto.hasFocus = function hasFocus() {
        return stealthFocus() ? false : nativeHasFocus.call(this);
      };
      const visDesc = Object.getOwnPropertyDescriptor(DocProto, 'visibilityState');
      if (visDesc && typeof visDesc.get === 'function') nativeVisibility = visDesc.get;
      const patchGetter = (name, fakeValue) => {
        const desc = Object.getOwnPropertyDescriptor(DocProto, name);
        if (!desc || typeof desc.get !== 'function') return;
        Object.defineProperty(DocProto, name, {
          configurable: true,
          enumerable: desc.enumerable,
          get: function () {
            return stealthHidden() ? fakeValue : desc.get.call(this);
          },
        });
      };
      patchGetter('visibilityState', 'hidden');
      patchGetter('hidden', true);
      patchGetter('webkitVisibilityState', 'hidden');
      patchGetter('webkitHidden', true);
      // window focus events would tell Messenger the user is looking at the chat
      win.addEventListener(
        'focus',
        function (e) {
          if (stealthFocus() && (e.target === win || e.target === doc)) e.stopImmediatePropagation();
        },
        true
      );
    } catch (e) {
      noteError(e);
    }

    // Route changes inside Facebook's single-page app. pushState/replaceState are wrapped so
    // the switch happens before the new page renders (Messenger reads the focus flag as soon
    // as a chat opens); popstate covers Back/Forward, and a slow poll catches anything else.
    try {
      // Added at page start: Facebook reads the (already faked) state itself. Added later (a tab
      // open before an install or update): Facebook started with the real focus, so the first
      // check below tells it, if this is a Messenger page, that the window is not focused.
      stealthWas = lateInjected ? false : stealthFocus();
      hiddenWas = lateInjected ? false : stealthHidden();
      state.diag.strongMode = stealthWas;
      syncStealth();
      const HistoryProto = win.History && win.History.prototype;
      for (const name of ['pushState', 'replaceState']) {
        const orig = HistoryProto && HistoryProto[name];
        if (typeof orig !== 'function') continue;
        HistoryProto[name] = function () {
          const r = orig.apply(this, arguments);
          try {
            syncStealth();
          } catch (e) {
            noteError(e);
          }
          return r;
        };
      }
      win.addEventListener('popstate', syncStealth, true);
      win.addEventListener('hashchange', syncStealth, true);
      win.setInterval(syncStealth, 1000);
    } catch (e) {
      noteError(e);
    }

    /* ---------------- Downloads: find the file behind a photo or video ---------------- */
    // The content script marks the element the user pointed at (data-mms-pick) and asks
    // here, because only the page's own JavaScript world can read React's data on it.
    // Everything is read-only: nothing on the page is changed.

    const FUNCTION_FIBER_TAGS = new Set([0, 11, 14, 15]); // function, forwardRef, memo components

    function fiberOf(el) {
      try {
        for (const k of Object.keys(el)) {
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
        }
      } catch (e) {
        /* ignore */
      }
      return null;
    }

    /** Calls scan(value) on each React props / hook value from the element upward. */
    function eachFiberValue(el, levels, scan) {
      let f = fiberOf(el);
      for (let i = 0; f && i < levels; i++, f = f.return) {
        try {
          if (f.memoizedProps && typeof f.memoizedProps === 'object' && scan(f.memoizedProps, i) === true) return;
          if (FUNCTION_FIBER_TAGS.has(f.tag)) {
            let h = f.memoizedState;
            for (let j = 0; h && typeof h === 'object' && j < 80; j++, h = h.next) {
              const v = h.memoizedState;
              if (v && typeof v === 'object' && scan(v, i) === true) return;
            }
          } else if (f.memoizedState && typeof f.memoizedState === 'object' && f.tag === 1) {
            if (scan(f.memoizedState, i) === true) return;
          }
        } catch (e) {
          /* a getter that throws: go on upward */
        }
      }
    }

    /**
     * The video files in React's data nearest to the element. With `wantId` (a video the
     * user's link points to) only that video counts; without it the closest one wins.
     */
    function videoFromFibers(el, wantId) {
      let knownId = '';
      let found = null;
      const allowAnon = el.tagName === 'VIDEO';
      const total = { n: 0, max: 120000 }; // keeps one click's search to a few dozen milliseconds
      eachFiberValue(el, 45, (value) => {
        if (total.n >= total.max) return true;
        if (!knownId) {
          for (const k of VIDEO_ID_KEYS) {
            const id = numericId(value[k]);
            if (id) {
              knownId = id;
              break;
            }
          }
        }
        const list = findVideoSources(value, { budget: 1500, maxDepth: 9, total });
        if (!list.length) return false;
        if (wantId) {
          const exact = list.find((v) => v.id === wantId) || (allowAnon ? list.find((v) => !v.id) : null);
          if (!exact) return false; // someone else's video: keep looking further up
          found = exact;
          return true;
        }
        found = pickVideo(list, knownId);
        return true;
      });
      return { video: found, knownId: knownId || (found && found.id) || '' };
    }

    function videoIdNear(el) {
      try {
        const a = el.closest && el.closest('a[href]');
        const own = a && videoIdFromUrl(a.getAttribute('href'));
        if (own) return own;
        let box = el;
        for (let i = 0; box && i < 14; i++) {
          if (box.getAttribute && box.getAttribute('role') === 'article') break;
          box = box.parentElement;
        }
        if (!box) return '';
        for (const link of box.querySelectorAll('a[href*="/videos/"], a[href*="/watch"], a[href*="/reel/"], a[href*="video.php"]')) {
          const id = videoIdFromUrl(link.getAttribute('href'));
          if (id) return id;
        }
      } catch (e) {
        /* ignore */
      }
      return '';
    }

    function videoFromScripts(id) {
      try {
        for (const s of doc.querySelectorAll('script[type="application/json"]')) {
          const text = s.textContent || '';
          if (text.indexOf(id) === -1 || !/progressive_url|browser_native_|playable_url|hd_src|sd_src|manifest_xml|dash_manifest/.test(text)) continue;
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            continue;
          }
          const hit = findVideoSources(data, { budget: 400000, maxDepth: 90 }).find((v) => v.id === id);
          if (hit) return hit;
        }
      } catch (e) {
        noteError(e);
      }
      return null;
    }

    /** Last resort for a video id: read the video's own page, as opening it would. */
    async function videoFromVideoPage(id) {
      if (!/(^|\.)facebook\.com$/i.test(String(win.location.hostname || ''))) return null;
      for (const path of ['/reel/' + id + '/', '/watch/?v=' + id, '/video.php?v=' + id]) {
        try {
          const resp = await nativeFetch.call(win, path, { credentials: 'include' });
          if (!resp.ok) continue;
          const html = await resp.text();
          const list = [];
          for (const data of videoJsonFromHtml(html)) list.push(...findVideoSources(data, { budget: 400000, maxDepth: 90 }));
          const exact = list.find((v) => v.id === id && (v.hd || v.sd || v.dash));
          if (exact) return exact;
          const withFiles = list.filter((v) => v.hd || v.sd || v.dash);
          const ids = new Set(withFiles.map((v) => v.id));
          if (withFiles.length && ids.size === 1) return withFiles[0]; // a page with just this one video
        } catch (e) {
          /* try the next address */
        }
      }
      return null;
    }

    function imageFor(el) {
      let shown = '';
      try {
        shown = el.currentSrc || el.src || (el.href && el.href.baseVal) || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      } catch (e) {
        shown = '';
      }
      if (!isFbMediaUrl(shown)) return shown;
      const key = imageFileKey(shown);
      const copies = [];
      const total = { n: 0, max: 60000 };
      eachFiberValue(el, 30, (value) => {
        copies.push(...findImageCopies(value, key, { budget: 800, maxDepth: 7, total }));
        return copies.length > 60 || total.n >= total.max;
      });
      return bestImage(shown, copies);
    }

    function mergeVideo(a, b) {
      if (!a) return b || null;
      if (!b) return a;
      return { id: a.id || b.id, hd: a.hd || b.hd, sd: a.sd || b.sd, dash: a.dash || b.dash };
    }

    state.resolveMedia = async function resolveMedia(d) {
      let el = null;
      const pick = String(d.pick || '').replace(/[^a-z0-9_-]/gi, '');
      if (pick) el = doc.querySelector('[data-mms-pick="' + pick + '"]');
      if (d.kind === 'image') return el ? { kind: 'image', url: imageFor(el) } : null;

      let id = numericId(d.id);
      let found = null;
      if (el) {
        const r = videoFromFibers(el, id);
        found = r.video;
        if (!id) id = numericId(r.knownId) || (found && found.id) || videoIdNear(el);
      }
      if (!id && !found) id = videoIdFromUrl(win.location.href);
      if (found && id && found.id && found.id !== id) found = null; // never another video's file
      if (!(found && (found.hd || found.sd)) && id) found = mergeVideo(found, videoFromScripts(id));
      if (!(found && (found.hd || found.sd)) && id) found = mergeVideo(found, await videoFromVideoPage(id));
      const result = { kind: 'video', id: id || (found && found.id) || '', hd: '', sd: '', dashVideo: '', dashAudio: '', dashHeight: 0 };
      if (found) {
        result.hd = found.hd || '';
        result.sd = found.sd || '';
        if (!result.hd && !result.sd && found.dash) {
          const tracks = dashTracks(found.dash);
          if (tracks) {
            result.dashVideo = tracks.video;
            result.dashAudio = tracks.audio;
            result.dashHeight = tracks.height;
          }
        }
      }
      return result;
    };

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
    findVideoSources,
    pickVideo,
    dashTracks,
    videoIdFromUrl,
    videoJsonFromHtml,
    imageFileKey,
    stpArea,
    findImageCopies,
    bestImage,
    isProgressiveUrl,
    CHANNEL_OUT,
    CHANNEL_IN,
  };

  if (typeof window === 'undefined' && typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  install(root);
})(typeof globalThis !== 'undefined' ? globalThis : this);
