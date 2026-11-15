// Small display helpers shared by the popup and the dashboard.

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  try {
    return sameDay ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return d.toISOString();
  }
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
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
  if (m.isMine) return 'You';
  if (m.senderName) return m.senderName;
  const c = m.senderId && contacts.get(m.senderId);
  if (c && c.name) return c.name;
  return threadName || 'Unknown';
}

export function threadTitle(t, contacts) {
  if (!t) return 'Unknown chat';
  if (t.name) return t.name;
  const c = contacts && contacts.get(t.threadKey);
  if (c && c.name) return c.name;
  if (t.domName) return t.domName;
  if (String(t.threadKey).startsWith('name:')) return String(t.threadKey).slice(5);
  return 'Chat ' + t.threadKey;
}
