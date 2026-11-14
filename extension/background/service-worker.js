// Messenger Message Saver - background worker.
// Receives captured data from the Facebook/Messenger tabs, stores it in the local
// database, recognises unsent / edited / deleted messages, downloads photos and
// shows desktop notifications. Nothing ever leaves this computer.

import { DEFAULT_SETTINGS, getSettings } from '../lib/settings.js';
import * as db from '../lib/db.js';

const { normalizeText, finalizeMessage, reqP } = db;

/* ---------------- settings cache ---------------- */

let settingsCache = null;

async function settings() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    settingsCache = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    updateBadge();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings: stored } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(stored || {}) } });
  chrome.alarms.create('mms-prune', { periodInMinutes: 360 });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#welcome') });
  }
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => updateBadge());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mms-prune') return;
  const s = await settings();
  if (s.retentionDays > 0) await db.prune(s.retentionDays);
});

/* ---------------- serial write queue ---------------- */
// All writes go through one chain so two tabs cannot overwrite each other's updates.

let chain = Promise.resolve();

function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((e) => console.warn('[MMS] write failed', e));
  return run;
}

/* ---------------- helpers ---------------- */

function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function addSource(rec, src) {
  rec.sources = rec.sources || [];
  if (!rec.sources.includes(src)) rec.sources.push(src);
}

function sameText(a, b) {
  return normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
}

function hasContent(rec) {
  return !!(normalizeText(rec.text) || (rec.attachments && rec.attachments.length));
}

function newRecord(key, fields) {
  return {
    key,
    text: '',
    attachments: [],
    history: [],
    sources: [],
    capturedAt: Date.now(),
    unsent: false,
    deleted: false,
    edited: false,
    ...fields,
  };
}

function isImageAttachment(a) {
  const mime = (a.mime || a.previewMime || a.playableMime || '').toLowerCase();
  return a.type === 1 || a.type === 2 || a.type === 3 || mime.startsWith('image/') || a.kind === 'sticker';
}

function mergeAttachment(rec, a) {
  rec.attachments = rec.attachments || [];
  const id = a.fbid || a.previewUrl || a.playableUrl || a.src || '';
  const existing = rec.attachments.find((x) => (x.fbid && x.fbid === a.fbid) || (id && (x.previewUrl === id || x.playableUrl === id || x.src === id)));
  const clean = {
    kind: a.kind || 'attachment',
    type: a.type || 0,
    fbid: a.fbid || '',
    filename: a.filename || '',
    mime: a.mime || a.previewMime || a.playableMime || '',
    previewUrl: a.previewUrl || a.src || '',
    playableUrl: a.playableUrl || '',
    width: a.width || 0,
    height: a.height || 0,
    title: a.title || '',
    subtitle: a.subtitle || '',
    actionUrl: a.actionUrl || '',
    durationMs: a.durationMs || 0,
  };
  if (existing) {
    for (const [k, v] of Object.entries(clean)) if (v && !existing[k]) existing[k] = v;
    return existing;
  }
  rec.attachments.push(clean);
  return clean;
}

async function contactName(id) {
  if (!id) return '';
  const c = await db.withStores(['contacts'], 'readonly', (s) => reqP(s.contacts.get(id)));
  return (c && c.name) || '';
}

async function threadName(threadKey) {
  const t = await db.withStores(['threads'], 'readonly', (s) => reqP(s.threads.get(threadKey)));
  if (t && (t.name || t.domName)) return t.name || t.domName;
  return contactName(threadKey);
}

/* ---------------- network (LightSpeed) ingest ---------------- */

async function ingestLs(ev, ctx) {
  const s = await settings();
  if (!s.enabled || !s.saveMessages) return;
  const selfId = ctx.selfId || '';
  const now = Date.now();
  const notices = [];
  const mediaJobs = [];

  await db.withStores(['messages', 'threads', 'contacts', 'events'], 'readwrite', async (st) => {
    for (const c of ev.contacts || []) {
      if (!c.id || !c.name) continue;
      const old = (await reqP(st.contacts.get(c.id))) || {};
      st.contacts.put({ ...old, id: c.id, name: c.name, pic: c.pic || old.pic || '', updatedAt: now });
    }
    for (const t of ev.threads || []) {
      if (!t.threadKey) continue;
      const old = (await reqP(st.threads.get(t.threadKey))) || { threadKey: t.threadKey };
      st.threads.put({
        ...old,
        name: t.name || old.name || '',
        pic: t.pic || old.pic || '',
        type: t.type || old.type || 0,
        lastActivity: Math.max(t.lastActivity || 0, old.lastActivity || 0),
        snippet: t.snippet || old.snippet || '',
        updatedAt: now,
      });
    }
    for (const sn of ev.snippets || []) {
      if (!sn.threadKey || !sn.snippet) continue;
      const old = (await reqP(st.threads.get(sn.threadKey))) || { threadKey: sn.threadKey };
      st.threads.put({ ...old, snippet: sn.snippet, updatedAt: now });
    }

    const touched = new Map();
    const getRec = async (key) => {
      if (touched.has(key)) return touched.get(key);
      const r = (await reqP(st.messages.get(key))) || null;
      if (r) touched.set(key, r);
      return r;
    };
    const stub = (id, threadKey, ts) => newRecord('fb:' + id, { mid: id, threadKey: threadKey || '', ts: ts || now, senderId: '', isMine: false });

    for (const m of ev.messages || []) {
      const key = 'fb:' + m.id;
      let rec = await getRec(key);
      if (!rec) {
        rec = newRecord(key, {
          mid: m.id,
          otid: m.otid || '',
          threadKey: m.threadKey,
          senderId: m.senderId,
          isMine: !!selfId && m.senderId === selfId,
          text: m.text || '',
          ts: m.ts || now,
          replyText: m.replyText || m.replySnippet || '',
          stickerId: m.stickerId || '',
          isAdmin: !!m.isAdmin,
        });
      } else {
        if (!rec.threadKey) rec.threadKey = m.threadKey;
        if (!rec.senderId && m.senderId) {
          rec.senderId = m.senderId;
          rec.isMine = !!selfId && m.senderId === selfId;
        }
        if (m.ts && (!rec.ts || rec.ts === rec.capturedAt)) rec.ts = m.ts;
        if (m.text && !rec.unsent) {
          if (!normalizeText(rec.text)) rec.text = m.text;
          else if (!sameText(rec.text, m.text)) {
            rec.history = [...(rec.history || []), { text: rec.text, at: now }];
            rec.text = m.text;
            rec.edited = true;
            rec.editedAt = now;
            st.events.add({ type: 'edited', messageKey: key, threadKey: rec.threadKey, at: now, text: rec.text });
            notices.push({ kind: 'edited', rec });
          }
        }
      }
      addSource(rec, 'network');
      touched.set(key, rec);
    }

    for (const a of ev.attachments || []) {
      if (!a.messageId) continue;
      const key = 'fb:' + a.messageId;
      let rec = await getRec(key);
      if (!rec) rec = stub(a.messageId, a.threadKey, a.ts);
      const att = mergeAttachment(rec, a);
      addSource(rec, 'network');
      touched.set(key, rec);
      if (s.saveMedia && isImageAttachment(att) && !att.mediaKey) {
        const url = att.previewUrl || att.playableUrl;
        if (url) mediaJobs.push({ messageKey: key, url, fbid: att.fbid });
      }
    }

    for (const e of ev.edits || []) {
      const key = 'fb:' + e.id;
      const rec = await getRec(key);
      if (!rec) continue;
      if (e.text && !sameText(e.text, rec.text)) {
        if (normalizeText(rec.text)) rec.history = [...(rec.history || []), { text: rec.text, at: now }];
        rec.text = e.text;
        rec.edited = true;
        rec.editedAt = now;
        st.events.add({ type: 'edited', messageKey: key, threadKey: rec.threadKey, at: now, text: e.text });
        notices.push({ kind: 'edited', rec });
        touched.set(key, rec);
      }
    }

    for (const h of ev.editHistory || []) {
      const key = 'fb:' + h.id;
      const rec = await getRec(key);
      if (!rec || !h.text) continue;
      const known = sameText(h.text, rec.text) || (rec.history || []).some((x) => sameText(x.text, h.text));
      if (!known) {
        rec.history = [{ text: h.text, at: h.ts || 0, fromServer: true }, ...(rec.history || [])];
        rec.edited = true;
        touched.set(key, rec);
      }
    }

    for (const r of ev.reactions || []) {
      const key = 'fb:' + r.messageId;
      const rec = await getRec(key);
      if (!rec || !r.actorId) continue;
      rec.reactions = { ...(rec.reactions || {}) };
      if (r.removed || !r.reaction) delete rec.reactions[r.actorId];
      else rec.reactions[r.actorId] = r.reaction;
      touched.set(key, rec);
    }

    for (const u of ev.unsent || []) {
      const key = 'fb:' + u.id;
      let rec = await getRec(key);
      if (!rec) {
        if (u.weak) continue;
        rec = stub(u.id, u.threadKey, u.ts);
        rec.senderId = u.senderId || '';
        rec.isMine = !!selfId && u.senderId === selfId;
        rec.text = '';
        rec.notCaptured = true;
      }
      if (!rec.unsent) {
        rec.unsent = true;
        rec.unsentAt = u.unsentTs || now;
        const recovered = hasContent(rec);
        st.events.add({ type: 'unsent', messageKey: key, threadKey: rec.threadKey, at: now, text: rec.text, recovered });
        if (recovered) notices.push({ kind: 'unsent', rec });
      }
      addSource(rec, 'network');
      touched.set(key, rec);
    }

    for (const d of ev.deleted || []) {
      const key = 'fb:' + d.id;
      const rec = await getRec(key);
      if (!rec || rec.unsent || rec.deleted) continue;
      rec.deleted = true;
      rec.deletedAt = now;
      st.events.add({ type: 'deleted', messageKey: key, threadKey: rec.threadKey, at: now, text: rec.text, recovered: hasContent(rec) });
      touched.set(key, rec);
    }

    for (const rec of touched.values()) st.messages.put(finalizeMessage(rec));
  });

  for (const n of notices) await notify(n);
  for (const j of mediaJobs) queueMedia(j);
  if (notices.some((n) => n.kind === 'unsent')) updateBadge();
}

/* ---------------- on-screen (DOM) ingest ---------------- */

/** Record key for a message seen on screen; normal chats share the network record's key. */
function domKeyFor(domId) {
  return /^mid\./.test(domId) ? 'fb:' + domId : 'dm:' + domId;
}

function nameKey(name) {
  const n = normalizeText(name).toLowerCase();
  return n ? 'name:' + n : '';
}

function domThreadKey(thread) {
  if (thread && thread.id) return String(thread.id);
  // a 1:1 pop-up links to the person's profile: a stable key (for normal chats it is the chat id)
  if (thread && thread.altIds && thread.altIds.length) return String(thread.altIds[0]);
  return nameKey(thread && thread.name) || 'name:unknown';
}

/**
 * Remembers the chat and links the keys one chat can be saved under (page id, profile id,
 * pop-up name). A name seen for two different chats is marked ambiguous and never linked.
 */
async function rememberDomThread(thread) {
  const threadKey = domThreadKey(thread);
  const now = Date.now();
  const nk = nameKey(thread.name);
  await db.withStores(['threads'], 'readwrite', async (st) => {
    const old = (await reqP(st.threads.get(threadKey))) || { threadKey };
    const rec = {
      ...old,
      domName: thread.name || old.domName || '',
      e2ee: old.e2ee || !!thread.e2ee,
      url: thread.url || old.url || '',
      altIds: [...new Set([...(old.altIds || []), ...(thread.altIds || [])])],
      updatedAt: now,
    };
    if (!nk || nk === threadKey) {
      st.threads.put(rec);
      return;
    }
    const nameRec = (await reqP(st.threads.get(nk))) || { threadKey: nk, domName: thread.name, pageIds: [], profileIds: [] };
    const pageIds = new Set(nameRec.pageIds || []);
    const profileIds = new Set(nameRec.profileIds || []);
    if (thread.id) pageIds.add(String(thread.id));
    else if (thread.altIds && thread.altIds.length) profileIds.add(String(thread.altIds[0]));
    const ambiguous = pageIds.size > 1 || profileIds.size > 1;
    const nameNext = { ...nameRec, pageIds: [...pageIds], profileIds: [...profileIds], ambiguous, updatedAt: now };
    if (ambiguous) delete nameNext.aliasFor;
    else if (thread.id) nameNext.aliasFor = String(thread.id);
    else if (!nameNext.aliasFor && profileIds.size === 1) nameNext.aliasFor = [...profileIds][0];
    st.threads.put(nameNext);
    // the same person's pop-up (profile id) and chat page (encrypted chat id): link them
    if (!ambiguous && pageIds.size === 1 && profileIds.size === 1) {
      const pageId = [...pageIds][0];
      const profileId = [...profileIds][0];
      if (pageId !== profileId) {
        const prof = profileId === threadKey ? rec : (await reqP(st.threads.get(profileId))) || { threadKey: profileId };
        if (prof.aliasFor !== pageId) {
          prof.aliasFor = pageId;
          prof.updatedAt = now;
          if (profileId !== threadKey) st.threads.put(prof);
        }
      }
    }
    st.threads.put(rec);
  });
  return threadKey;
}

async function ingestDom(batch, ctx) {
  const s = await settings();
  if (!s.enabled || !s.saveMessages || !s.captureDom) return { ok: false };
  const thread = batch.thread || {};
  const threadKey = await rememberDomThread(thread);
  const chatKeys = await db.threadKeysFor(threadKey);
  for (const id of thread.altIds || []) if (id && !chatKeys.includes(String(id))) chatKeys.push(String(id));
  const now = Date.now();
  const notices = [];
  const mediaJobs = [];

  await db.withStores(['messages', 'events', 'aliases'], 'readwrite', async (st) => {
    const touched = new Map();
    const byDomId = async (domId) => {
      if (!domId) return null;
      for (const r of touched.values()) if (r.domId === domId) return r;
      // normal chats show Messenger's own message id ("mid.$...") on screen
      if (/^mid\./.test(domId)) {
        const net = touched.get('fb:' + domId) || (await reqP(st.messages.get('fb:' + domId)));
        if (net) return net;
      }
      const direct = await reqP(st.messages.index('domId').get(domId));
      if (direct) return direct;
      const alias = await reqP(st.aliases.get(domId));
      return alias ? (touched.get(alias.messageKey) || (await reqP(st.messages.get(alias.messageKey))) || null) : null;
    };
    const byText = async (text, isMine) => {
      if (!text) return null;
      let matches = [];
      for (const k of chatKeys) matches = matches.concat(await reqP(st.messages.index('textKey').getAll(db.textKeyOf(k, text))));
      return (
        matches.find((m) => !m.domId && m.isMine === isMine) ||
        matches.find((m) => !m.domId) ||
        null
      );
    };

    for (const it of batch.items || []) {
      const text = normalizeText(it.text);
      const images = (it.images || []).filter((im) => im && (im.src || im.dataUrl));
      const extras = (it.extras || []).filter((x) => x && x.kind);
      if (!text && !images.length && !extras.length) continue;
      const isMine = it.isMine === true;
      let rec = (await byDomId(it.domId)) || (await byText(text, isMine));
      const fallbackKey = 'dom:' + hash53([threadKey, isMine ? 'me' : normalizeText(it.senderName).toLowerCase(), text, images.map((i) => i.key || '').join(',')].join('|'));
      if (!rec) rec = touched.get(fallbackKey) || (await reqP(st.messages.get(fallbackKey))) || null;
      if (!rec) {
        rec = newRecord(it.domId ? domKeyFor(it.domId) : fallbackKey, {
          threadKey,
          domId: it.domId || '',
          senderName: isMine ? 'You' : it.senderName || '',
          isMine: it.isMine === null || it.isMine === undefined ? undefined : isMine,
          text,
          ts: it.ts || now,
          approxTime: !(it.ts && it.exactTime),
          domContext: { prev: it.prev || '', next: it.next || '' },
          stamp: it.stamp || '',
          e2ee: !!thread.e2ee,
        });
      } else {
        if (it.domId && !rec.domId) rec.domId = it.domId;
        if (it.stamp && !rec.stamp) rec.stamp = it.stamp;
        if (!rec.senderName && it.senderName && !isMine) rec.senderName = it.senderName;
        if (rec.isMine === undefined && typeof it.isMine === 'boolean') rec.isMine = it.isMine;
        if (!rec.domContext) rec.domContext = { prev: it.prev || '', next: it.next || '' };
        else {
          if (!rec.domContext.prev && it.prev) rec.domContext.prev = it.prev;
          if (!rec.domContext.next && it.next) rec.domContext.next = it.next;
        }
        if (it.ts && it.exactTime && rec.approxTime) {
          rec.ts = it.ts;
          rec.approxTime = false;
        }
        // same message, different text on screen: it was edited
        if (text && normalizeText(rec.text) && !sameText(rec.text, text) && !rec.unsent) {
          const knownBefore = (rec.history || []).some((h) => sameText(h.text, text));
          if (!knownBefore) {
            rec.history = [...(rec.history || []), { text: rec.text, at: now }];
            rec.text = text;
            rec.edited = true;
            rec.editedAt = now;
            st.events.add({ type: 'edited', messageKey: rec.key, threadKey: rec.threadKey, at: now, text });
            notices.push({ kind: 'edited', rec });
          }
        } else if (text && !normalizeText(rec.text)) rec.text = text;
      }
      rec.lastSeenAt = now;
      for (const im of images) {
        const att = mergeAttachment(rec, {
          kind: 'screen-image',
          type: 2,
          previewUrl: im.src && !im.src.startsWith('blob:') && !im.src.startsWith('data:') ? im.src : '',
          mime: 'image/*',
          width: im.w || 0,
          height: im.h || 0,
          fbid: im.key || (im.dataUrl ? 'data:' + hash53(im.dataUrl.slice(0, 4096) + im.dataUrl.length) : ''),
          title: im.alt && im.alt !== 'Open photo' ? im.alt : '',
        });
        if (s.saveMedia && !att.mediaKey) {
          if (im.dataUrl) mediaJobs.push({ messageKey: rec.key, dataUrl: im.dataUrl, fbid: att.fbid });
          else if (im.src && /^https:\/\/[^/]*\.fbcdn\.net\//.test(im.src)) mediaJobs.push({ messageKey: rec.key, url: im.src, fbid: att.fbid });
        }
      }
      for (const x of extras) {
        mergeAttachment(rec, {
          kind: x.kind === 'link' ? 'link' : x.kind,
          type: x.kind === 'voice' ? 5 : x.kind === 'video' ? 4 : 7,
          title: x.title || '',
          actionUrl: x.url || '',
          fbid: x.kind + ':' + hash53((x.title || '') + (x.url || '')),
        });
      }
      addSource(rec, 'screen');
      touched.set(rec.key, rec);
    }

    // a message turned into "unsent" while it was on screen
    for (const u of batch.unsentNow || []) {
      const text = normalizeText(u.text);
      let rec = (await byDomId(u.domId)) || null;
      if (!rec && text) {
        let matches = [];
        for (const k of chatKeys) matches = matches.concat(await reqP(st.messages.index('textKey').getAll(db.textKeyOf(k, text))));
        rec = matches.find((m) => !m.unsent) || matches[0] || null;
      }
      if (!rec) {
        if (!text) continue;
        rec = newRecord(u.domId ? domKeyFor(u.domId) : 'dom:' + hash53([threadKey, u.isMine ? 'me' : normalizeText(u.senderName).toLowerCase(), text, ''].join('|')), {
          threadKey,
          domId: u.domId || '',
          senderName: u.isMine ? 'You' : u.senderName || '',
          isMine: !!u.isMine,
          text,
          ts: u.ts || now,
          approxTime: !u.ts,
          domContext: { prev: u.prev || '', next: u.next || '' },
          e2ee: !!thread.e2ee,
        });
      }
      // remember the placeholder's new id so the original is found after a reload
      if (u.newDomId && u.newDomId !== rec.domId) st.aliases.put({ domId: u.newDomId, messageKey: rec.key, at: now });
      if (rec.unsent) continue;
      rec.unsent = true;
      rec.unsentAt = now;
      if (u.stamp && !rec.stamp) rec.stamp = u.stamp;
      addSource(rec, 'screen');
      st.events.add({ type: 'unsent', messageKey: rec.key, threadKey: rec.threadKey, at: now, text: rec.text, recovered: hasContent(rec) });
      if (hasContent(rec)) notices.push({ kind: 'unsent', rec });
      touched.set(rec.key, rec);
    }

    for (const rec of touched.values()) st.messages.put(finalizeMessage(rec));
  });

  for (const n of notices) await notify(n);
  for (const j of mediaJobs) queueMedia(j);
  if (notices.length) updateBadge();
  return { ok: true, threadKey };
}

/* ---------------- notifications from Messenger itself ---------------- */

async function ingestNotification(n) {
  const s = await settings();
  if (!s.enabled || !s.saveMessages || !s.captureNotifications) return;
  if (!n || (!n.body && !n.title)) return;
  await db.withStores(['notifications'], 'readwrite', async (st) => {
    st.notifications.add({ title: n.title || '', body: n.body || '', tag: n.tag || '', ts: n.ts || Date.now() });
  });
}

/* ---------------- finding the original of "X unsent a message" ---------------- */

function neighbourTexts(sorted) {
  const map = new Map();
  for (let i = 0; i < sorted.length; i++) {
    let p = i - 1;
    while (p >= 0 && !normalizeText(sorted[p].text)) p--;
    let n = i + 1;
    while (n < sorted.length && !normalizeText(sorted[n].text)) n++;
    map.set(sorted[i].key, {
      prev: p >= 0 ? normalizeText(sorted[p].text).toLowerCase() : '',
      next: n < sorted.length ? normalizeText(sorted[n].text).toLowerCase() : '',
    });
  }
  return map;
}

/** Photos for the in-chat box; budget.bytes keeps one reply well under Chrome's 64 MB message limit. */
async function mediaPreview(rec, budget = { bytes: 16 * 1024 * 1024 }, maxItems = 4) {
  const out = [];
  for (const a of rec.attachments || []) {
    if (out.length >= maxItems) break;
    if (a.mediaKey) {
      const m = await db.getMedia(a.mediaKey);
      if (m && m.blob && m.blob.size <= 3 * 1024 * 1024 && m.blob.size * 1.4 <= budget.bytes) {
        budget.bytes -= m.blob.size * 1.4;
        out.push({ dataUrl: await blobToDataUrl(m.blob), title: a.title || a.filename || '' });
        continue;
      }
    }
    if (a.previewUrl) out.push({ url: a.previewUrl, title: a.title || a.filename || '' });
    else if (a.title || a.filename) out.push({ title: a.title || a.filename });
  }
  return out;
}

const COMMON_TEXTS = new Set(['ok', 'okay', 'k', 'kk', 'yes', 'no', 'yeah', 'yep', 'ya', 'haha', 'hahaha', 'lol', 'hmm', 'hi', 'hello', 'hey', 'thanks', 'thank you', 'ty', 'oh', 'ah', 'acha', 'hmm ok', 'ki', 'na', 'ha']);

/** A neighbouring text that can identify a position (not "ok", "haha" or a lone emoji). */
function distinctive(t) {
  const n = normalizeText(t).toLowerCase();
  return n.length >= 4 && !COMMON_TEXTS.has(n) && !/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s\p{P}]+$/u.test(n);
}

/** true / false when both names are known, null when one is missing. Accepts "Alpha" vs "Alpha Smith". */
function sameSender(a, b) {
  const x = normalizeText(a).toLowerCase();
  const y = normalizeText(b).toLowerCase();
  if (!x || !y) return null;
  if (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')) return true;
  return x.split(' ')[0] === y.split(' ')[0];
}

async function lookupPlaceholders(req) {
  const thread = req.thread || {};
  const keys = new Set();
  const base = domThreadKey(thread);
  for (const k of await db.threadKeysFor(base)) keys.add(k);
  const nk = nameKey(thread.name);
  if (nk && nk !== base) {
    // a pop-up's name only helps when no other chat uses the same name
    const nameRec = await db.withStores(['threads'], 'readonly', (st) => reqP(st.threads.get(nk)));
    if (!nameRec || !nameRec.ambiguous) for (const k of await db.threadKeysFor(nk)) keys.add(k);
  }
  for (const id of thread.altIds || []) if (id) for (const k of await db.threadKeysFor(String(id))) keys.add(k);
  let msgs = [];
  for (const k of keys) msgs = msgs.concat(await db.messagesByThread(k));
  const byKey = new Map(msgs.map((m) => [m.key, m]));
  msgs = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  const neighbours = neighbourTexts(msgs.filter((m) => !m.unsent || hasContent(m)));
  const visible = new Set((req.visibleTexts || []).map((t) => normalizeText(t).toLowerCase()));
  const visibleIds = new Set(req.visibleDomIds || []);
  const contacts = await db.getContactsMap();
  const results = [];
  const discovered = [];
  const usedKeys = new Set();
  const budget = { bytes: 16 * 1024 * 1024 };

  const describe = async (c, confidence) => ({
    key: c.key,
    text: c.text || '',
    ts: c.ts,
    approxTime: !!c.approxTime,
    unsentAt: c.unsentAt || 0,
    senderName: c.senderName || (contacts.get(c.senderId) || {}).name || '',
    media: await mediaPreview(c, budget),
    confidence,
  });

  // 1) exact: the placeholder still carries the message's id
  const rest = [];
  for (const ph of req.placeholders || []) {
    let exact = null;
    if (ph.domId) {
      exact = await db.withStores(['messages', 'aliases'], 'readonly', async (st) => {
        const direct = await reqP(st.messages.index('domId').get(ph.domId));
        if (direct) return direct;
        const alias = await reqP(st.aliases.get(ph.domId));
        return alias ? (await reqP(st.messages.get(alias.messageKey))) || null : null;
      });
    }
    if (exact && hasContent(exact)) {
      usedKeys.add(exact.key);
      if (!exact.unsent) discovered.push(exact.key);
      results.push({ pid: ph.pid, ...(await describe(exact, 'high')) });
    } else rest.push(ph);
  }

  // 2) by position - only with positive evidence: the same time, the same "At <time>, <Sender>"
  //    label, or distinctive neighbouring messages. Senders and directions must not disagree.
  const candidates = msgs.filter(
    (m) =>
      hasContent(m) &&
      !usedKeys.has(m.key) &&
      !(m.domId && visibleIds.has(m.domId)) &&
      !(normalizeText(m.text) && visible.has(normalizeText(m.text).toLowerCase()))
  );
  const pairs = [];
  rest.forEach((ph, pi) => {
    const pPrev = normalizeText(ph.prev).toLowerCase();
    const pNext = normalizeText(ph.next).toLowerCase();
    candidates.forEach((c, ci) => {
      if (typeof ph.isMine === 'boolean' && typeof c.isMine === 'boolean' && ph.isMine !== c.isMine) return;
      const nameMatch = sameSender(ph.senderName, c.senderName || (contacts.get(c.senderId) || {}).name);
      if (nameMatch === false) return;
      let timeMatch = false;
      if (ph.ts && c.ts && !c.approxTime) {
        const d = Math.abs(ph.ts - c.ts);
        if (d > 3 * 60000) return; // a different minute: a different message
        timeMatch = d <= 90000;
      }
      const stampMatch = !!(ph.stamp && c.stamp && normalizeText(ph.stamp) === normalizeText(c.stamp));
      const ctx = c.domContext ? { prev: normalizeText(c.domContext.prev).toLowerCase(), next: normalizeText(c.domContext.next).toLowerCase() } : neighbours.get(c.key) || { prev: '', next: '' };
      let near = 0;
      if (distinctive(pPrev) && pPrev === ctx.prev) near++;
      if (distinctive(pNext) && pNext === ctx.next) near++;
      const identity = (timeMatch || stampMatch ? 1 : 0) + near;
      if (!identity) return;
      if (!c.unsent && !c.deleted && identity < 2) return; // not known to be unsent: need two signals
      const score = (c.unsent ? 4 : c.deleted ? 2 : 0) + (timeMatch ? 5 : 0) + (stampMatch ? 5 : 0) + 4 * near + (nameMatch ? 1 : 0);
      if (score >= 8) pairs.push({ pi, ci, score, ts: c.ts, strong: (timeMatch || stampMatch) && (near > 0 || c.unsent) });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.pi - b.pi || a.ts - b.ts);
  const usedP = new Set();
  const usedC = new Set();
  for (const p of pairs) {
    if (usedP.has(p.pi) || usedC.has(p.ci)) continue;
    usedP.add(p.pi);
    usedC.add(p.ci);
    // a positional match is only shown, never written back as "unsent"
    results.push({ pid: rest[p.pi].pid, ...(await describe(candidates[p.ci], p.strong ? 'high' : 'medium')) });
  }
  if (discovered.length) serial(() => markDiscoveredUnsent(discovered));
  return { results };
}

/** A saved message found in the place of an "unsent" placeholder: record it as unsent. */
async function markDiscoveredUnsent(keys) {
  const now = Date.now();
  await db.withStores(['messages', 'events'], 'readwrite', async (st) => {
    for (const key of keys) {
      const rec = await reqP(st.messages.get(key));
      if (!rec || rec.unsent) continue;
      rec.unsent = true;
      rec.unsentAt = now;
      rec.unsentDiscovered = true;
      st.events.add({ type: 'unsent', messageKey: key, threadKey: rec.threadKey, at: now, text: rec.text, recovered: true });
      st.messages.put(finalizeMessage(rec));
    }
  });
  updateBadge();
}

async function lookupEdited(req) {
  const thread = req.thread || {};
  const keys = await db.threadKeysFor(domThreadKey(thread));
  const items = req.items || (req.texts || []).map((text) => ({ text, domId: '' }));
  const out = [];
  for (const it of items) {
    let rec = null;
    if (it.domId) rec = await db.withStores(['messages'], 'readonly', (st) => reqP(st.messages.index('domId').get(it.domId)));
    if (!rec || !(rec.history && rec.history.length)) {
      rec = null;
      for (const k of keys) {
        const matches = await db.findByText(k, it.text);
        rec = matches.find((m) => m.history && m.history.length);
        if (rec) break;
      }
    }
    if (rec && rec.history && rec.history.length) {
      out.push({ text: it.text, domId: it.domId || '', history: rec.history.map((h) => h.text).filter((x) => normalizeText(x) && !sameText(x, it.text)) });
    }
  }
  return { results: out };
}

/* ---------------- media download ---------------- */

const mediaQueue = [];
let mediaActive = 0;

function queueMedia(job) {
  if (mediaQueue.length > 500) return;
  mediaQueue.push(job);
  pumpMedia();
}

function pumpMedia() {
  while (mediaActive < 2 && mediaQueue.length) {
    const job = mediaQueue.shift();
    mediaActive++;
    saveMedia(job)
      .catch((e) => console.debug('[MMS] media not saved', e && e.message))
      .finally(() => {
        mediaActive--;
        pumpMedia();
      });
  }
}

function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: mime });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function saveMedia(job) {
  const s = await settings();
  if (!s.saveMedia) return;
  const maxBytes = Math.max(1, s.maxMediaMB || 15) * 1024 * 1024;
  const mediaKey = job.fbid ? 'fbid:' + job.fbid : 'url:' + hash53(job.url || job.dataUrl.slice(0, 2000));
  const existing = await db.getMedia(mediaKey);
  let blob = existing && existing.blob;
  if (!blob) {
    if (job.dataUrl) blob = dataUrlToBlob(job.dataUrl);
    else {
      if (!/^https:\/\/([a-z0-9-]+\.)*(fbcdn\.net|facebook\.com|messenger\.com)\//i.test(job.url)) return;
      const resp = await fetch(job.url, { credentials: 'omit', cache: 'force-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const len = Number(resp.headers.get('content-length') || 0);
      if (len && len > maxBytes) return;
      blob = await resp.blob();
    }
    if (!blob || blob.size > maxBytes) return;
  }
  await serial(() =>
    db.withStores(['media', 'messages'], 'readwrite', async (st) => {
      if (!existing) st.media.put({ key: mediaKey, blob, mime: blob.type, size: blob.size, url: job.url || '', messageKey: job.messageKey, savedAt: Date.now() });
      const rec = await reqP(st.messages.get(job.messageKey));
      if (!rec) return;
      for (const a of rec.attachments || []) {
        const match = (job.fbid && a.fbid === job.fbid) || (job.url && (a.previewUrl === job.url || a.playableUrl === job.url));
        if (match || (!job.fbid && !job.url && !a.mediaKey)) {
          a.mediaKey = mediaKey;
          break;
        }
      }
      st.messages.put(finalizeMessage(rec));
    })
  );
}

/* ---------------- desktop notifications & badge ---------------- */

async function notify(n) {
  const s = await settings();
  const rec = n.rec;
  if (rec.isMine) return;
  if (n.kind === 'unsent' && !s.notifyOnUnsend) return;
  if (n.kind === 'edited' && !s.notifyOnEdit) return;
  const who = rec.senderName || (await contactName(rec.senderId)) || (await threadName(rec.threadKey)) || 'Someone';
  const what = normalizeText(rec.text) || (rec.attachments && rec.attachments.length ? '[photo / attachment]' : '');
  const title = n.kind === 'unsent' ? `${who} unsent a message` : `${who} edited a message`;
  const message = n.kind === 'unsent' ? `"${what.slice(0, 220)}"` : `Before: "${normalizeText((rec.history || []).slice(-1)[0]?.text).slice(0, 100)}"\nNow: "${what.slice(0, 100)}"`;
  try {
    await chrome.notifications.create('mms|' + encodeURIComponent(rec.threadKey) + '|' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      contextMessage: 'Messenger Message Saver',
      priority: 1,
    });
  } catch (e) {
    console.debug('[MMS] notification failed', e);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('mms|')) return;
  const threadKey = decodeURIComponent(id.split('|')[1] || '');
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#thread=' + encodeURIComponent(threadKey)) });
  chrome.notifications.clear(id);
});

async function updateBadge() {
  try {
    const s = await settings();
    if (!s.badge || !s.enabled) {
      await chrome.action.setBadgeText({ text: s.enabled ? '' : 'off' });
      return;
    }
    const { badgeSince = 0 } = await chrome.storage.local.get('badgeSince');
    const events = await db.recentEvents(200);
    const count = events.filter((e) => e.type === 'unsent' && e.recovered && e.at > badgeSince).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#e0245e' });
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' });
  } catch (e) {
    console.debug('[MMS] badge', e);
  }
}

/* ---------------- unseen counters & diagnostics ---------------- */

async function countUnseen(actions) {
  if (!actions || !actions.length) return;
  const { stats = {} } = await chrome.storage.local.get('stats');
  for (const a of actions) {
    if (a.type === 'seen-blocked') stats.seenBlocked = (stats.seenBlocked || 0) + 1;
    if (a.type === 'typing-blocked') stats.typingBlocked = (stats.typingBlocked || 0) + 1;
  }
  await chrome.storage.local.set({ stats });
}

/* ---------------- keyboard shortcut ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-unseen') return;
  const s = await settings();
  const next = { ...s, blockSeen: !s.blockSeen };
  await chrome.storage.local.set({ settings: next });
  try {
    await chrome.notifications.create('mms-unseen|' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: next.blockSeen ? 'Unseen mode is ON' : 'Unseen mode is OFF',
      message: next.blockSeen ? 'People will not see "Seen" when you read.' : 'Messenger will show "Seen" again when you read.',
      priority: 0,
    });
  } catch (e) {
    /* notifications blocked */
  }
});

/* ---------------- message router ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const fromTab = sender.tab ? sender.tab.id : null;
  const work = async () => {
    switch (msg.type) {
      case 'ingest-ls':
        return serial(() => ingestLs(msg.events || {}, msg.ctx || {}));
      case 'ingest-dom':
        return serial(() => ingestDom(msg.batch || {}, msg.ctx || {}));
      case 'ingest-notification':
        return serial(() => ingestNotification(msg.notification));
      case 'unseen-actions':
        return serial(() => countUnseen(msg.actions));
      case 'diag':
        if (fromTab !== null) await chrome.storage.session.set({ ['diag:' + fromTab]: { ...msg.diag, at: Date.now(), url: (sender.tab && sender.tab.url) || '' } });
        return true;
      case 'lookup-placeholders':
        return lookupPlaceholders(msg);
      case 'lookup-edited':
        return lookupEdited(msg);
      case 'badge-seen':
        await chrome.storage.local.set({ badgeSince: Date.now() });
        await updateBadge();
        return true;
      case 'open-dashboard':
        await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html' + (msg.hash || '')) });
        return true;
      case 'refresh-badge':
        await updateBadge();
        return true;
      default:
        return undefined;
    }
  };
  work().then(
    (r) => sendResponse(r === undefined ? null : r),
    (e) => sendResponse({ error: String((e && e.message) || e) })
  );
  return true;
});
