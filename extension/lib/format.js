// Small display helpers shared by the popup and the dashboard (including the interface language).

import './i18n.js'; // defines globalThis.MMS_I18N

const I18N = globalThis.MMS_I18N;
let LANG = 'en';

/** Picks the interface language from the setting ('auto' follows the browser). */
export function setUiLanguage(pref) {
  LANG = I18N.resolve(pref || 'auto');
  return LANG;
}

export function lang() {
  return LANG;
}

/** The text for a key in the current language; {name} parts are filled from vars. */
export function t(key, vars) {
  return I18N.translate(LANG, key, vars);
}

/** Translates the page's data-i18n parts and sets <html lang>. */
export function applyI18n(root = document) {
  I18N.apply(root, LANG);
}

export function fmtNum(n) {
  return I18N.num(n, LANG);
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  try {
    const loc = I18N.locale(LANG);
    return sameDay ? d.toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return d.toISOString();
  }
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('justNow');
  if (s < 3600) return t('minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('hoursAgo', { n: Math.floor(s / 3600) });
  if (s < 7 * 86400) return t('daysAgo', { n: Math.floor(s / 86400) });
  return fmtTime(ts);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** Display name of the person who sent a saved message. */
export function senderOf(m, contacts, threadName) {
  if (m.isMine) return t('you');
  if (m.senderName) return m.senderName;
  const c = m.senderId && contacts.get(m.senderId);
  if (c && c.name) return c.name;
  return threadName || t('unknown');
}

export function threadTitle(tr, contacts) {
  if (!tr) return t('unknownChat');
  if (tr.name) return tr.name;
  const c = contacts && contacts.get(tr.threadKey);
  if (c && c.name) return c.name;
  if (tr.domName) return tr.domName;
  if (String(tr.threadKey).startsWith('name:')) return String(tr.threadKey).slice(5);
  return t('chatN', { key: tr.threadKey });
}

/** Attachment titles the extension itself stored in English ("Voice message", "Video"). */
export function attTitle(title) {
  if (title === 'Voice message') return t('att.voiceTitle');
  if (title === 'Video') return t('att.videoTitle');
  return title;
}
