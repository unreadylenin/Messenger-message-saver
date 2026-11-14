// Local database (IndexedDB in the extension's own storage - never sent anywhere).
// Used by the background worker, the popup and the dashboard.

export const DB_NAME = 'messenger-message-saver';
export const DB_VERSION = 3;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'key' });
        s.createIndex('threadKey', 'threadKey');
        s.createIndex('thread_ts', ['threadKey', 'ts']);
        s.createIndex('status', 'status');
        s.createIndex('ts', 'ts');
        s.createIndex('textKey', 'textKey');
        s.createIndex('domId', 'domId');
      }
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'threadKey' });
      if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) {
        const m = db.createObjectStore('media', { keyPath: 'key' });
        m.createIndex('messageKey', 'messageKey');
      }
      if (!db.objectStoreNames.contains('notifications')) {
        const n = db.createObjectStore('notifications', { keyPath: 'id', autoIncrement: true });
        n.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('events')) {
        const e = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        e.createIndex('at', 'at');
      }
      // v2: a message whose on-screen id changed (encrypted chats change it on unsend)
      if (!db.objectStoreNames.contains('aliases')) db.createObjectStore('aliases', { keyPath: 'domId' });
      // v3: photo downloads still to do (kept here so they survive the worker being stopped)
      if (!db.objectStoreNames.contains('pendingMedia')) db.createObjectStore('pendingMedia', { keyPath: 'id' });
      const msgStore = req.transaction.objectStore('messages');
      if (!msgStore.indexNames.contains('domId')) msgStore.createIndex('domId', 'domId');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/**
 * Runs fn(stores) in one transaction. Inside fn only await IndexedDB requests
 * (reqP), otherwise the transaction closes early.
 */
export async function withStores(names, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(names, mode);
  const done = txDone(tx);
  const stores = {};
  for (const n of names) stores[n] = tx.objectStore(n);
  let result;
  try {
    result = await fn(stores, tx);
  } catch (e) {
    try {
      tx.abort();
    } catch (_) {
      /* already finished */
    }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

/* ---------------- text helpers ---------------- */

export function normalizeText(t) {
  return String(t || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textKeyOf(threadKey, text) {
  const n = normalizeText(text);
  return n ? `${threadKey}\u0001${n.toLowerCase()}` : '';
}

export function statusOf(m) {
  // an unsent message we never saw has nothing to show: kept apart from the recovered ones
  if (m.unsent) return normalizeText(m.text) || (m.attachments && m.attachments.length) ? 'unsent' : 'unsent-empty';
  if (m.deleted) return 'deleted';
  if (m.edited) return 'edited';
  return 'normal';
}

/** Recomputes derived fields before a message is written. */
export function finalizeMessage(m) {
  m.status = statusOf(m);
  m.textKey = textKeyOf(m.threadKey, m.text);
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) m.ts = m.capturedAt || Date.now();
  return m;
}

/* ---------------- reads ---------------- */

export async function getMessage(key) {
  return withStores(['messages'], 'readonly', (s) => reqP(s.messages.get(key)));
}

export async function messagesByThread(threadKey) {
  const list = await withStores(['messages'], 'readonly', (s) => reqP(s.messages.index('thread_ts').getAll(IDBKeyRange.bound([threadKey, -Infinity], [threadKey, Infinity]))));
  return list;
}

/** A chat can be saved under its id and (from chat pop-ups) under its name: return both. */
export async function threadKeysFor(threadKey) {
  const threads = await getAll('threads');
  const keys = new Set([threadKey]);
  const linked = (t) => t.aliasFor && !t.ambiguous;
  for (const t of threads) if (linked(t) && t.aliasFor === threadKey) keys.add(t.threadKey);
  const self = threads.find((t) => t.threadKey === threadKey);
  if (self && linked(self)) {
    keys.add(self.aliasFor);
    for (const t of threads) if (linked(t) && t.aliasFor === self.aliasFor) keys.add(t.threadKey);
  }
  return [...keys];
}

export async function messagesByThreadMerged(threadKey) {
  const keys = await threadKeysFor(threadKey);
  const all = [];
  for (const k of keys) all.push(...(await messagesByThread(k)));
  const seen = new Set();
  return all
    .filter((m) => (seen.has(m.key) ? false : seen.add(m.key)))
    .sort((a, b) => a.ts - b.ts);
}

export async function findByText(threadKey, text) {
  const tk = textKeyOf(threadKey, text);
  if (!tk) return [];
  return withStores(['messages'], 'readonly', (s) => reqP(s.messages.index('textKey').getAll(tk)));
}

export async function messagesByStatus(status, limit = 500) {
  const list = await withStores(['messages'], 'readonly', (s) => reqP(s.messages.index('status').getAll(status)));
  list.sort((a, b) => (b.unsentAt || b.editedAt || b.ts) - (a.unsentAt || a.editedAt || a.ts));
  return list.slice(0, limit);
}

export async function getAll(storeName) {
  return withStores([storeName], 'readonly', (s) => reqP(s[storeName].getAll()));
}

export async function getContactsMap() {
  const contacts = await getAll('contacts');
  const map = new Map();
  for (const c of contacts) map.set(c.id, c);
  return map;
}

export async function getMedia(key) {
  return withStores(['media'], 'readonly', (s) => reqP(s.media.get(key)));
}

export async function recentEvents(limit = 50) {
  return withStores(['events'], 'readonly', async (s) => {
    const out = [];
    await new Promise((resolve, reject) => {
      const req = s.events.index('at').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve();
        out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out;
  });
}

/** Totals from index counts only - cheap even with a very large history. */
export async function quickTotals() {
  return withStores(['messages', 'media'], 'readonly', async (s) => {
    const idx = s.messages.index('status');
    const [messages, unsent, unsentEmpty, edited, deleted, media] = await Promise.all([
      reqP(s.messages.count()),
      reqP(idx.count('unsent')),
      reqP(idx.count('unsent-empty')),
      reqP(idx.count('edited')),
      reqP(idx.count('deleted')),
      reqP(s.media.count()),
    ]);
    // unsent = unsent messages whose content was kept; unsentEmpty = unsent before they were seen
    return { messages, unsent, unsentEmpty, edited, deleted, media };
  });
}

/** One pass over all messages: per-thread counters + totals. */
export async function summarize() {
  const [messages, threads, contacts] = await Promise.all([getAll('messages'), getAll('threads'), getAll('contacts')]);
  const byThread = new Map();
  const totals = { messages: 0, unsent: 0, edited: 0, deleted: 0, media: 0 };
  for (const m of messages) {
    totals.messages++;
    if (m.unsent) totals.unsent++;
    if (m.edited) totals.edited++;
    if (m.deleted) totals.deleted++;
    let t = byThread.get(m.threadKey);
    if (!t) {
      t = { threadKey: m.threadKey, total: 0, unsent: 0, edited: 0, deleted: 0, lastTs: 0 };
      byThread.set(m.threadKey, t);
    }
    t.total++;
    if (m.unsent) t.unsent++;
    if (m.edited) t.edited++;
    if (m.deleted) t.deleted++;
    if (m.ts > t.lastTs) t.lastTs = m.ts;
  }
  totals.media = await withStores(['media'], 'readonly', (s) => reqP(s.media.count()));
  const threadMap = new Map(threads.map((t) => [t.threadKey, t]));
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  // fold chats saved under a pop-up name into the chat id they belong to
  for (const [key, t] of [...byThread.entries()]) {
    const info = threadMap.get(key);
    if (!info || !info.aliasFor || info.ambiguous || info.aliasFor === key) continue;
    let target = byThread.get(info.aliasFor);
    if (!target) {
      target = { threadKey: info.aliasFor, total: 0, unsent: 0, edited: 0, deleted: 0, lastTs: 0 };
      byThread.set(info.aliasFor, target);
    }
    target.total += t.total;
    target.unsent += t.unsent;
    target.edited += t.edited;
    target.deleted += t.deleted;
    target.lastTs = Math.max(target.lastTs, t.lastTs);
    byThread.delete(key);
  }
  const list = [];
  for (const t of byThread.values()) {
    const info = threadMap.get(t.threadKey) || {};
    let name = info.name || '';
    if (!name && contactMap.has(t.threadKey)) name = contactMap.get(t.threadKey).name;
    list.push({ ...t, name: name || info.domName || '', pic: info.pic || '', e2ee: !!info.e2ee, snippet: info.snippet || '' });
  }
  list.sort((a, b) => b.lastTs - a.lastTs);
  return { totals, threads: list };
}

export async function searchMessages(query, { threadKey = null, status = null, limit = 300 } = {}) {
  const q = normalizeText(query).toLowerCase();
  const all = threadKey ? await messagesByThread(threadKey) : await getAll('messages');
  const out = [];
  for (const m of all) {
    if (status && status !== 'all' && m.status !== status && !(status === 'media' && m.attachments && m.attachments.length)) continue;
    if (q) {
      const hay = [m.text, ...(m.history || []).map((h) => h.text), ...(m.attachments || []).map((a) => `${a.title || ''} ${a.filename || ''}`)]
        .join(' \n ')
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(m);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

/* ---------------- maintenance ---------------- */

/** Deletes photos that no saved message points to any more (photos can be shared by several messages). */
export async function collectUnusedMedia() {
  const used = new Set();
  for (const m of await getAll('messages')) for (const a of m.attachments || []) if (a.mediaKey) used.add(a.mediaKey);
  const keys = await withStores(['media'], 'readonly', (s) => reqP(s.media.getAllKeys()));
  const unused = keys.filter((k) => !used.has(k));
  if (unused.length) await withStores(['media'], 'readwrite', async (s) => unused.forEach((k) => s.media.delete(k)));
  return unused.length;
}

/**
 * Deletes everything saved from one chat: messages, their unsend/edit history entries,
 * id aliases, queued photo downloads, Messenger notification copies titled with the chat's
 * name, and photos no other chat uses.
 */
export async function deleteThread(threadKey, { name = '' } = {}) {
  const msgs = await messagesByThread(threadKey);
  const keys = new Set(msgs.map((m) => m.key));
  const [aliases, pending, events, notifications] = await Promise.all(['aliases', 'pendingMedia', 'events', 'notifications'].map(getAll));
  const title = normalizeText(name).toLowerCase();
  await withStores(['messages', 'threads', 'aliases', 'pendingMedia', 'events', 'notifications'], 'readwrite', async (s) => {
    for (const m of msgs) s.messages.delete(m.key);
    for (const al of aliases) if (keys.has(al.messageKey)) s.aliases.delete(al.domId);
    for (const j of pending) if (keys.has(j.messageKey)) s.pendingMedia.delete(j.id);
    for (const e of events) if (e.threadKey === threadKey || keys.has(e.messageKey)) s.events.delete(e.id);
    if (title) for (const n of notifications) if (normalizeText(n.title).toLowerCase() === title) s.notifications.delete(n.id);
    s.threads.delete(threadKey);
  });
  await collectUnusedMedia();
  return msgs.length;
}

export async function clearAll() {
  await withStores(['messages', 'threads', 'contacts', 'media', 'notifications', 'events', 'aliases', 'pendingMedia'], 'readwrite', async (s) => {
    for (const k of Object.keys(s)) s[k].clear();
  });
}

export async function prune(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = 0;
  await withStores(['messages', 'media', 'notifications', 'events'], 'readwrite', async (s) => {
    await new Promise((resolve, reject) => {
      const req = s.messages.index('ts').openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        cur.delete();
        removed++;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    s.notifications.index('ts').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = function () {
      const cur = this.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    s.events.index('at').openCursor(IDBKeyRange.upperBound(cutoff)).onsuccess = function () {
      const cur = this.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
  });
  if (removed) await collectUnusedMedia();
  return removed;
}

/* ---------------- export / import ---------------- */

function blobToBase64(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  });
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

export async function exportAll({ includeMedia = true } = {}) {
  const [messages, threads, contacts, notifications, events, aliases] = await Promise.all(['messages', 'threads', 'contacts', 'notifications', 'events', 'aliases'].map(getAll));
  const out = {
    format: 'messenger-message-saver',
    version: 2,
    exportedAt: new Date().toISOString(),
    messages,
    threads,
    contacts,
    notifications,
    events,
    aliases,
    media: [],
  };
  if (includeMedia) {
    for (const m of await getAll('media')) {
      if (m.blob instanceof Blob) out.media.push({ key: m.key, mime: m.mime, url: m.url, messageKey: m.messageKey, savedAt: m.savedAt, size: m.size, data: await blobToBase64(m.blob) });
    }
  }
  return out;
}

/**
 * The backup file, built from parts so photos never have to fit in one string.
 * It is ordinary JSON, written with one photo per line:
 *   {"format":...,"messages":[...],...,"media":[
 *   {photo 1}
 *   ,{photo 2}
 *   ]}
 */
export async function exportBlob({ includeMedia = true } = {}) {
  const base = await exportAll({ includeMedia: false });
  delete base.media;
  const head = JSON.stringify(base);
  const parts = [new Blob([head.slice(0, -1) + ',"media":[\n'])];
  let count = 0;
  if (includeMedia) {
    const keys = await withStores(['media'], 'readonly', (s) => reqP(s.media.getAllKeys()));
    for (const key of keys) {
      const m = await getMedia(key);
      if (!m || !(m.blob instanceof Blob)) continue;
      const line = JSON.stringify({ key: m.key, mime: m.mime, url: m.url, messageKey: m.messageKey, savedAt: m.savedAt, size: m.size, data: await blobToBase64(m.blob) });
      parts.push(new Blob([(count ? ',' : '') + line + '\n']));
      count++;
    }
  }
  parts.push(new Blob([']}']));
  return { blob: new Blob(parts, { type: 'application/json' }), photos: count };
}

/** Restores a backup file of any size: the photos are read one line at a time. */
export async function importFile(file, onProgress, { streamAbove = 64 * 1024 * 1024 } = {}) {
  if (file.size < streamAbove) return importAll(JSON.parse(await file.text()));
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let head = null;
  const counts = { messages: 0, threads: 0, contacts: 0, media: 0 };
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const c = await importAll({ format: 'messenger-message-saver', media: batch });
    counts.media += c.media;
    batch = [];
    if (onProgress) onProgress(counts);
  };
  const handleLine = async (line) => {
    if (head === null) {
      head = line;
      if (!head.endsWith('"media":[')) throw new Error('This backup is too large to restore in one piece and is not in the expected layout.');
      const base = JSON.parse(head + ']}');
      const c = await importAll(base);
      counts.messages = c.messages;
      counts.threads = c.threads;
      counts.contacts = c.contacts;
      return;
    }
    let l = line.trim();
    if (!l || l === ']}') return;
    if (l.startsWith(',')) l = l.slice(1);
    batch.push(JSON.parse(l));
    if (batch.length >= 20) await flush();
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      await handleLine(line);
    }
    if (done) break;
  }
  if (buf.trim()) await handleLine(buf);
  await flush();
  return counts;
}

export async function importAll(data) {
  if (!data || data.format !== 'messenger-message-saver') throw new Error('This file is not a Messenger Message Saver backup.');
  const counts = { messages: 0, threads: 0, contacts: 0, media: 0 };
  const existing = new Map();
  if ((data.messages || []).length) for (const m of await getAll('messages')) existing.set(m.key, m);
  const threadsNow = new Map((data.threads || []).length ? (await getAll('threads')).map((t) => [t.threadKey, t]) : []);
  const contactsNow = new Map((data.contacts || []).length ? (await getAll('contacts')).map((c) => [c.id, c]) : []);
  const notifSeen = new Set((data.notifications || []).length ? (await getAll('notifications')).map((n) => [n.ts, n.title, n.body].join('|')) : []);
  const eventSeen = new Set((data.events || []).length ? (await getAll('events')).map((e) => [e.type, e.messageKey, e.at].join('|')) : []);
  await withStores(['messages', 'threads', 'contacts', 'notifications', 'events', 'media', 'aliases'], 'readwrite', async (s) => {
    for (const a of data.aliases || []) if (a && a.domId && a.messageKey) s.aliases.put(a);
    for (const m of data.messages || []) {
      const old = existing.get(m.key);
      const merged = old ? mergeImported(old, m) : m;
      s.messages.put(finalizeMessage(merged));
      counts.messages++;
    }
    for (const t of data.threads || []) {
      s.threads.put(mergeRecord(threadsNow.get(t.threadKey), t, ['ambiguous']));
      counts.threads++;
    }
    for (const c of data.contacts || []) {
      s.contacts.put(mergeRecord(contactsNow.get(c.id), c, []));
      counts.contacts++;
    }
    for (const n of data.notifications || []) {
      const k = [n.ts, n.title, n.body].join('|');
      if (notifSeen.has(k)) continue;
      notifSeen.add(k);
      const { id, ...rest } = n;
      s.notifications.add(rest);
    }
    for (const e of data.events || []) {
      const k = [e.type, e.messageKey, e.at].join('|');
      if (eventSeen.has(k)) continue;
      eventSeen.add(k);
      const { id, ...rest } = e;
      s.events.add(rest);
    }
    for (const md of data.media || []) {
      if (!md || !md.data) continue;
      s.media.put({ key: md.key, mime: md.mime, url: md.url, messageKey: md.messageKey, savedAt: md.savedAt, size: md.size, blob: base64ToBlob(md.data, md.mime) });
      counts.media++;
    }
  });
  return counts;
}

/** Field-by-field merge: the newer record wins, empty values never overwrite, sticky flags stay set. */
function mergeRecord(current, incoming, sticky) {
  if (!current) return incoming;
  const newer = (incoming.updatedAt || 0) > (current.updatedAt || 0);
  const [base, over] = newer ? [current, incoming] : [incoming, current];
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) if (v !== '' && v !== null && v !== undefined) out[k] = v;
  for (const k of sticky) if (current[k] || incoming[k]) out[k] = true;
  if (out.ambiguous) delete out.aliasFor;
  return out;
}

function mergeImported(a, b) {
  const out = { ...a, ...b };
  out.text = a.text || b.text;
  out.unsent = !!(a.unsent || b.unsent);
  out.deleted = !!(a.deleted || b.deleted);
  out.edited = !!(a.edited || b.edited);
  const hist = [...(a.history || []), ...(b.history || [])];
  const seen = new Set();
  out.history = hist.filter((h) => {
    const k = h.text + '|' + h.at;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // same attachment in both: keep one, and keep whichever copy knows its saved photo
  const byKey = new Map();
  for (const x of [...(a.attachments || []), ...(b.attachments || [])]) {
    const k = x.fbid || x.url || x.previewUrl || JSON.stringify(x);
    const prev = byKey.get(k);
    if (!prev) byKey.set(k, { ...x });
    else for (const [f, v] of Object.entries(x)) if (v && !prev[f]) prev[f] = v;
  }
  out.attachments = [...byKey.values()];
  return out;
}
