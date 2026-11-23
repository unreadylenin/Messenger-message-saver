// Rules for data that came from web pages or from a backup file. Everything saved is treated as
// untrusted: it can come from a script running on facebook.com, from a contact in an encrypted
// chat, or from a hand-edited backup. Shared by the background worker, the database module,
// the Saved Messages page and the tests.

const FB_HOST = /^https:\/\/(?:[a-z0-9-]+\.)*(?:fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com)(?::443)?\//i;
const IMAGE_MIME = /^image\/(?:jpeg|png|gif|webp|avif|bmp)$/;
const DATA_IMAGE = /^data:image\/(?:jpeg|png|gif|webp|avif|bmp)[;,]/i;
const MAX_URL = 8000;

/** Most that is kept of one field, so a page cannot fill the disk through one message. */
export const LIMITS = Object.freeze({
  text: 20000,
  name: 500,
  history: 50,
  attachments: 60,
  notificationTitle: 300,
  notificationBody: 5000,
  pendingMedia: 500,
});

/** An https address on Facebook's own servers. */
export function isFbUrl(url) {
  const u = typeof url === 'string' ? url : '';
  return u.length <= MAX_URL && FB_HOST.test(u);
}

/** A photo type that is safe to write into an HTML attribute or a data: address. */
export function safeImageMime(type) {
  const t = String(type || '')
    .toLowerCase()
    .trim();
  if (t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg';
  return IMAGE_MIME.test(t) ? t : 'image/jpeg';
}

/** The same blob with a safe photo type (the bytes are not copied). */
export function retypeImageBlob(blob) {
  if (!blob || typeof blob.slice !== 'function') return blob;
  const type = safeImageMime(blob.type);
  return blob.type === type ? blob : blob.slice(0, blob.size, type);
}

/** An address that may be stored or opened as a link: https only (no javascript:, data:, file:). */
export function httpsUrl(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u || u.length > MAX_URL) return '';
  try {
    return new URL(u).protocol === 'https:' ? u : '';
  } catch (e) {
    return '';
  }
}

export const safeLinkHref = httpsUrl;

/** An address a picture may be loaded from: Facebook's servers, this page's own memory, or inline photo data. */
export function safeImgSrc(url) {
  const u = typeof url === 'string' ? url : '';
  if (isFbUrl(u) || /^blob:/i.test(u) || DATA_IMAGE.test(u)) return u;
  return '';
}

/** A string of at most n characters ('' for anything that is not text or a number). */
export function clip(value, n) {
  if (typeof value === 'string') return value.length > n ? value.slice(0, n) : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, n);
  return '';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One attachment, rebuilt field by field from what the code knows. */
export function cleanAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    kind: clip(a.kind, 40) || 'attachment',
    type: num(a.type),
    fbid: clip(a.fbid, 300),
    filename: clip(a.filename, LIMITS.name),
    mime: clip(a.mime, 100),
    previewUrl: httpsUrl(a.previewUrl),
    playableUrl: httpsUrl(a.playableUrl),
    width: num(a.width),
    height: num(a.height),
    title: clip(a.title, LIMITS.name),
    subtitle: clip(a.subtitle, LIMITS.name),
    actionUrl: httpsUrl(a.actionUrl),
    durationMs: num(a.durationMs),
  };
  const mediaKey = clip(a.mediaKey, 400);
  if (mediaKey) out.mediaKey = mediaKey;
  return out;
}

function cleanHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h) => h && typeof h === 'object' && typeof h.text === 'string')
    .slice(-LIMITS.history)
    .map((h) => {
      const out = { text: clip(h.text, LIMITS.text), at: num(h.at) };
      if (h.fromServer) out.fromServer = true;
      return out;
    });
}

/** Caps the size of a message record in place (every write goes through this). */
export function capMessage(m) {
  if (!m || typeof m !== 'object') return m;
  if (typeof m.text !== 'string') m.text = clip(m.text, LIMITS.text);
  else if (m.text.length > LIMITS.text) m.text = m.text.slice(0, LIMITS.text);
  if (typeof m.replyText === 'string' && m.replyText.length > LIMITS.text) m.replyText = m.replyText.slice(0, LIMITS.text);
  if (typeof m.senderName === 'string' && m.senderName.length > LIMITS.name) m.senderName = m.senderName.slice(0, LIMITS.name);
  if (!Array.isArray(m.history)) m.history = [];
  else if (m.history.length > LIMITS.history || m.history.some((h) => !h || typeof h.text !== 'string' || h.text.length > LIMITS.text)) m.history = cleanHistory(m.history);
  if (!Array.isArray(m.attachments)) m.attachments = [];
  else if (m.attachments.length > LIMITS.attachments) m.attachments = m.attachments.slice(0, LIMITS.attachments);
  return m;
}

const BOOL_FIELDS = ['unsent', 'deleted', 'edited', 'isAdmin', 'approxTime', 'e2ee', 'notCaptured'];
const TIME_FIELDS = ['ts', 'capturedAt', 'unsentAt', 'deletedAt', 'editedAt', 'lastSeenAt', 'updatedAt'];
const TEXT_FIELDS = { mid: 300, otid: 300, threadKey: 300, senderId: 100, senderName: LIMITS.name, replyText: LIMITS.text, stickerId: 100, domId: 400, stamp: 300 };

/** A saved message from a backup file, rebuilt from known fields only (null if unusable). */
export function cleanImportedMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.key !== 'string' || !m.key || m.key.length > 500) return null;
  const out = { key: m.key, text: clip(m.text, LIMITS.text) };
  for (const [k, n] of Object.entries(TEXT_FIELDS)) {
    const v = clip(m[k], n);
    if (v) out[k] = v;
  }
  for (const k of BOOL_FIELDS) if (m[k]) out[k] = true;
  if (typeof m.isMine === 'boolean') out.isMine = m.isMine;
  for (const k of TIME_FIELDS) if (num(m[k])) out[k] = num(m[k]);
  out.history = cleanHistory(m.history);
  out.attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, LIMITS.attachments).map(cleanAttachment).filter(Boolean);
  out.sources = (Array.isArray(m.sources) ? m.sources : []).filter((s) => typeof s === 'string').slice(0, 5);
  if (m.reactions && typeof m.reactions === 'object' && !Array.isArray(m.reactions)) {
    const r = {};
    for (const [actor, reaction] of Object.entries(m.reactions).slice(0, 100)) {
      const a = clip(actor, 100);
      const v = clip(reaction, 40);
      if (a && v && a !== '__proto__') r[a] = v;
    }
    out.reactions = r;
  }
  if (m.srcText && typeof m.srcText === 'object') {
    const st = {};
    for (const k of ['network', 'screen']) if (typeof m.srcText[k] === 'string') st[k] = clip(m.srcText[k], LIMITS.text);
    out.srcText = st;
  }
  if (m.domContext && typeof m.domContext === 'object') out.domContext = { prev: clip(m.domContext.prev, 2000), next: clip(m.domContext.next, 2000) };
  return out;
}

/** A chat (thread) record from a backup file. */
export function cleanImportedThread(t) {
  if (!t || typeof t !== 'object' || typeof t.threadKey !== 'string' || !t.threadKey || t.threadKey.length > 500) return null;
  const out = { threadKey: t.threadKey };
  for (const [k, n] of Object.entries({ name: LIMITS.name, domName: LIMITS.name, snippet: 2000, aliasFor: 500, url: 2000 })) {
    const v = clip(t[k], n);
    if (v) out[k] = v;
  }
  if (out.url && !httpsUrl(out.url)) delete out.url;
  const pic = httpsUrl(t.pic);
  if (pic) out.pic = pic;
  for (const k of ['type', 'lastActivity', 'updatedAt']) if (num(t[k])) out[k] = num(t[k]);
  if (t.ambiguous) out.ambiguous = true;
  if (t.e2ee) out.e2ee = true;
  for (const k of ['pageIds', 'profileIds', 'altIds']) {
    if (Array.isArray(t[k])) out[k] = t[k].filter((x) => typeof x === 'string' && x.length <= 100).slice(0, 50);
  }
  return out;
}

/** A contact record from a backup file. */
export function cleanImportedContact(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || c.id.length > 200) return null;
  const out = { id: c.id, name: clip(c.name, LIMITS.name) };
  const pic = httpsUrl(c.pic);
  if (pic) out.pic = pic;
  if (num(c.updatedAt)) out.updatedAt = num(c.updatedAt);
  return out;
}

/** A saved Messenger notification copy from a backup file. */
export function cleanImportedNotification(n) {
  if (!n || typeof n !== 'object') return null;
  const out = { title: clip(n.title, LIMITS.notificationTitle), body: clip(n.body, LIMITS.notificationBody), tag: clip(n.tag, 300), ts: num(n.ts) };
  return out.title || out.body ? out : null;
}

/** An unsend/edit history event from a backup file. */
export function cleanImportedEvent(e) {
  if (!e || typeof e !== 'object' || !['unsent', 'deleted', 'edited'].includes(e.type)) return null;
  return { type: e.type, messageKey: clip(e.messageKey, 500), threadKey: clip(e.threadKey, 500), at: num(e.at), text: clip(e.text, LIMITS.text), recovered: !!e.recovered };
}

/** A saved-photo record from a backup file (the bytes stay base64 here). */
export function cleanImportedMedia(md) {
  if (!md || typeof md !== 'object' || typeof md.key !== 'string' || !md.key || md.key.length > 500 || typeof md.data !== 'string') return null;
  return { key: md.key, mime: safeImageMime(md.mime), url: httpsUrl(md.url), messageKey: clip(md.messageKey, 500), savedAt: num(md.savedAt), size: num(md.size), data: md.data };
}

const DIAG_NUMBERS = ['framesIn', 'framesOut', 'lsPrograms', 'messages', 'unsent', 'edits', 'seenBlocked', 'seenUnknown', 'typingBlocked', 'httpPayloads', 'notifications', 'errors'];
const DIAG_FLAGS = ['lateInjected', 'rawJson', 'strongMode'];

/** The tab's diagnostics report, reduced to the known counters (it comes from the page). */
export function cleanDiag(d) {
  const src = d && typeof d === 'object' ? d : {};
  const out = {};
  for (const k of DIAG_NUMBERS) out[k] = num(src[k]);
  for (const k of DIAG_FLAGS) out[k] = !!src[k];
  out.lastError = clip(src.lastError, 200);
  const so = src.sockets && typeof src.sockets === 'object' ? src.sockets : {};
  out.sockets = { dgw: num(so.dgw), mqtt: num(so.mqtt), e2ee: num(so.e2ee), other: num(so.other) };
  const dom = src.dom && typeof src.dom === 'object' ? src.dom : {};
  out.dom = { logs: num(dom.logs), rows: num(dom.rows), saved: num(dom.saved), placeholders: num(dom.placeholders), recovered: num(dom.recovered) };
  return out;
}

/** An alias (new id of an unsent row) from a backup file. */
export function cleanImportedAlias(a) {
  if (!a || typeof a !== 'object' || typeof a.domId !== 'string' || !a.domId || typeof a.messageKey !== 'string' || !a.messageKey) return null;
  return { domId: a.domId.slice(0, 400), messageKey: a.messageKey.slice(0, 500), at: num(a.at) };
}
