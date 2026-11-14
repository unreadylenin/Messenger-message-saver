import { getSettings, setSettings } from '../lib/settings.js';
import * as db from '../lib/db.js';
import { el, fmtTime, fmtAgo, senderOf, threadTitle } from '../lib/format.js';

const $ = (sel) => document.querySelector(sel);

// every Saved Messages tab (and the background worker) announces deletions here
const dataChannel = new BroadcastChannel('mms-data');

const state = {
  contacts: new Map(),
  threads: new Map(), // threadKey -> stored thread info
  summary: null,
  currentThread: null,
  msgFilter: 'all',
  unsentFilter: 'recovered',
  objectUrls: [],
};

/* ---------------- data ---------------- */

async function loadBasics() {
  const [contacts, threads, summary, totals] = await Promise.all([db.getContactsMap(), db.getAll('threads'), db.summarize(), db.quickTotals()]);
  state.contacts = contacts;
  state.threads = new Map(threads.map((t) => [t.threadKey, t]));
  state.summary = summary;
  const t = totals; // same definitions as the lists below
  $('#totals-line').textContent = `${t.messages} messages saved · ${t.unsent} unsent kept · ${t.edited} edited · ${t.media} photos`;
  const unsentTab = t.unsent + t.deleted;
  $('#c-unsent').textContent = unsentTab ? String(unsentTab) : '';
  $('#c-edited').textContent = t.edited ? String(t.edited) : '';
}

function threadInfo(threadKey) {
  const stored = state.threads.get(threadKey) || { threadKey };
  if (stored.aliasFor && !stored.ambiguous && state.threads.has(stored.aliasFor)) return state.threads.get(stored.aliasFor);
  return stored;
}

function nameOfThread(threadKey) {
  const t = threadInfo(threadKey);
  return threadTitle(t, state.contacts);
}

function hasContent(m) {
  return !!((m.text && m.text.trim()) || (m.attachments && m.attachments.length));
}

/* ---------------- rendering helpers ---------------- */

function revokeUrls() {
  for (const u of state.objectUrls) URL.revokeObjectURL(u);
  state.objectUrls = [];
}

function openLightbox(src) {
  const before = document.activeElement;
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
    if (before && before.focus) before.focus();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Photo (press Escape to close)', tabindex: '-1', onclick: close }, el('img', { src, alt: '' }));
  document.body.appendChild(box);
  document.addEventListener('keydown', onKey);
  box.focus();
}

function mediaBlock(m) {
  const wrap = el('div', { class: 'media' });
  for (const a of m.attachments || []) {
    const isImage = a.type === 1 || a.type === 2 || a.type === 3 || /^image\//.test(a.mime || '') || a.kind === 'sticker' || a.kind === 'screen-image';
    if (a.mediaKey) {
      const img = el('img', { alt: a.title || a.filename || 'saved photo', loading: 'lazy' });
      wrap.appendChild(img);
      db.getMedia(a.mediaKey).then((rec) => {
        if (rec && rec.blob) {
          const u = URL.createObjectURL(rec.blob);
          state.objectUrls.push(u);
          img.src = u;
          img.tabIndex = 0;
          img.addEventListener('click', () => openLightbox(u));
          img.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && openLightbox(u));
        } else img.replaceWith(el('span', { class: 'muted small', text: '🖼️ photo (not in this browser — it was not saved, or not included in a restored backup)' }));
      });
    } else if (isImage && a.previewUrl) {
      const img = el('img', { alt: a.title || 'photo', loading: 'lazy', referrerpolicy: 'no-referrer', src: a.previewUrl });
      img.addEventListener('error', () => img.replaceWith(el('span', { class: 'muted small', text: '🖼️ photo (link expired, not downloaded)' })));
      img.addEventListener('click', () => openLightbox(a.previewUrl));
      wrap.appendChild(img);
    } else {
      const label = a.title || a.filename || (a.type === 4 ? 'video' : a.type === 5 ? 'voice message' : a.type === 6 ? 'file' : 'attachment');
      const href = a.actionUrl || a.playableUrl || a.previewUrl || '';
      wrap.appendChild(href ? el('a', { class: 'att', href, target: '_blank', rel: 'noopener noreferrer', text: '📎 ' + label }) : el('span', { class: 'att', text: '📎 ' + label }));
    }
  }
  return wrap.childNodes.length ? wrap : null;
}

function statusBadges(m) {
  const out = [];
  if (m.unsent) out.push(el('span', { class: 'badge unsent', text: 'Unsent' + (m.unsentAt ? ' ' + fmtAgo(m.unsentAt) : '') }));
  if (m.deleted) out.push(el('span', { class: 'badge unsent', text: 'Deleted' }));
  if (m.edited) out.push(el('span', { class: 'badge edited', text: 'Edited' }));
  if (m.e2ee) out.push(el('span', { class: 'badge', text: '🔒 encrypted chat' }));
  return out;
}

function historyBlock(m) {
  const hist = (m.history || []).filter((h) => h.text && h.text.trim() && h.text !== m.text);
  if (!hist.length) return null;
  return el('div', { class: 'history' }, el('div', { class: 'muted small', text: 'Earlier versions:' }), ...hist.map((h) => el('div', { text: h.text })));
}

function copyButton(text) {
  return el('button', {
    class: 'btn small',
    text: 'Copy text',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied');
      } catch (e) {
        toast('Could not copy');
      }
    },
  });
}

function messageCard(m) {
  const tName = nameOfThread(m.threadKey);
  const who = senderOf(m, state.contacts, tName);
  const cls = ['card', m.unsent || m.deleted ? 'unsent' : m.edited ? 'edited' : ''].join(' ').trim();
  const text = (m.text || '').trim();
  return el(
    'article',
    { class: cls, dataset: { key: m.key } },
    el(
      'div',
      { class: 'meta' },
      el('span', { class: 'who', text: who }),
      el('button', { class: 'chat linklike', type: 'button', text: who !== tName ? 'in ' + tName : 'open chat', title: 'Open this chat', onclick: () => openThread(m.threadKey, m.key) }),
      el('span', { text: (m.approxTime ? 'saved ' : 'sent ') + fmtTime(m.ts) }),
      ...statusBadges(m)
    ),
    m.replyText ? el('div', { class: 'reply', text: '↪ ' + m.replyText }) : null,
    el('div', { class: 'text' + (text ? '' : ' empty'), text: text || (m.attachments && m.attachments.length ? '' : m.notCaptured ? 'This message was unsent before the extension could save it.' : '(no text)') }),
    mediaBlock(m),
    historyBlock(m),
    text ? el('div', { class: 'actions' }, copyButton(text)) : null
  );
}

function emptyState(text) {
  return el('div', { class: 'empty-state', text });
}

/* ---------------- views ---------------- */

async function renderUnsent() {
  revokeUrls();
  const list = $('#unsent-list');
  const [unsent, deleted, empty] = await Promise.all([db.messagesByStatus('unsent', 2000), db.messagesByStatus('deleted', 2000), state.unsentFilter === 'all' ? db.messagesByStatus('unsent-empty', 2000) : []]);
  let items = [...unsent, ...deleted, ...empty].sort((a, b) => (b.unsentAt || b.deletedAt || b.ts) - (a.unsentAt || a.deletedAt || a.ts));
  if (state.unsentFilter === 'recovered') items = items.filter(hasContent);
  list.textContent = '';
  if (!items.length) {
    list.appendChild(emptyState('No unsent messages yet. When someone unsends a message that reached this browser, it will show up here.'));
    return;
  }
  for (const m of items.slice(0, 500)) list.appendChild(messageCard(m));
}

async function renderEdited() {
  revokeUrls();
  const list = $('#edited-list');
  const items = await db.messagesByStatus('edited', 1000);
  list.textContent = '';
  if (!items.length) return list.appendChild(emptyState('No edited messages saved yet.'));
  for (const m of items) list.appendChild(messageCard(m));
}

async function renderNotifications() {
  const list = $('#notification-list');
  const items = (await db.getAll('notifications')).sort((a, b) => b.ts - a.ts).slice(0, 1000);
  list.textContent = '';
  if (!items.length) return list.appendChild(emptyState('No Messenger notifications captured yet.'));
  for (const n of items) {
    list.appendChild(
      el('article', { class: 'card' }, el('div', { class: 'meta' }, el('span', { class: 'who', text: n.title || 'Notification' }), el('span', { text: fmtTime(n.ts) })), el('div', { class: 'text', text: n.body || '' }))
    );
  }
}

function renderThreadList() {
  const ul = $('#thread-list');
  const q = $('#thread-filter').value.trim().toLowerCase();
  ul.textContent = '';
  const threads = (state.summary && state.summary.threads) || [];
  const shown = threads.filter((t) => !q || nameOfThread(t.threadKey).toLowerCase().includes(q));
  if (!shown.length) {
    ul.appendChild(el('li', { class: 'muted', text: threads.length ? 'No chat matches.' : 'No chats saved yet.' }));
    return;
  }
  for (const t of shown) {
    const name = nameOfThread(t.threadKey);
    const info = threadInfo(t.threadKey);
    const avatar = el('span', { class: 'avatar' });
    if (info.pic) {
      const img = el('img', { src: info.pic, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        img.remove();
        avatar.textContent = (name[0] || '?').toUpperCase();
      });
      avatar.appendChild(img);
    } else avatar.textContent = (name[0] || '?').toUpperCase();
    const sub = [`${t.total} saved`];
    if (t.unsent) sub.push(`${t.unsent} unsent`);
    if (t.edited) sub.push(`${t.edited} edited`);
    const li = el(
      'li',
      {
        class: state.currentThread === t.threadKey ? 'on' : '',
        dataset: { key: t.threadKey },
        tabindex: '0',
        role: 'button',
        'aria-current': state.currentThread === t.threadKey ? 'true' : null,
        onclick: () => openThread(t.threadKey),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openThread(t.threadKey);
          }
        },
      },
      avatar,
      el('div', { class: 'tinfo' }, el('div', { class: 'tname', text: name + (t.e2ee || info.e2ee ? ' 🔒' : '') }), el('div', { class: 'tsub', text: sub.join(' · ') + ' · ' + fmtAgo(t.lastTs) }))
    );
    ul.appendChild(li);
  }
}

async function renderThread(focusKey) {
  revokeUrls();
  const box = $('#thread-messages');
  box.textContent = '';
  if (!state.currentThread) {
    $('#thread-title').textContent = 'Pick a chat';
    box.appendChild(emptyState('Choose a chat on the left.'));
    return;
  }
  $('#thread-title').textContent = nameOfThread(state.currentThread);
  let msgs = await db.messagesByThreadMerged(state.currentThread);
  const f = state.msgFilter;
  if (f === 'unsent') msgs = msgs.filter((m) => m.unsent || m.deleted);
  else if (f === 'edited') msgs = msgs.filter((m) => m.edited);
  else if (f === 'media') msgs = msgs.filter((m) => m.attachments && m.attachments.length);
  if (!msgs.length) return box.appendChild(emptyState('Nothing to show with this filter.'));
  const tName = nameOfThread(state.currentThread);
  let lastDay = '';
  for (const m of msgs.slice(-3000)) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(el('div', { class: 'day-sep', text: new Date(m.ts).toLocaleDateString(undefined, { dateStyle: 'full' }) }));
    }
    const cls = ['bubble', m.isMine ? 'mine' : '', m.unsent ? 'unsent' : '', m.deleted ? 'deleted' : '', m.edited ? 'edited' : ''].filter(Boolean).join(' ');
    const text = (m.text || '').trim();
    const bubble = el(
      'div',
      { class: cls, dataset: { key: m.key } },
      el('div', { class: 'bmeta' }, el('b', { text: senderOf(m, state.contacts, tName) }), el('span', { text: new Date(m.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (m.approxTime ? ' (saved)' : '') }), ...statusBadges(m)),
      m.replyText ? el('div', { class: 'reply muted small', text: '↪ ' + m.replyText }) : null,
      text ? el('div', { class: 'text', text }) : !hasContent(m) ? el('div', { class: 'text muted', text: m.unsent ? 'Unsent before it could be saved.' : '(no text)' }) : null,
      mediaBlock(m),
      historyBlock(m)
    );
    box.appendChild(bubble);
  }
  if (focusKey) {
    const target = box.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
    }
  } else box.scrollTop = box.scrollHeight; // the timeline scrolls inside its own box
}

async function openThread(threadKey, focusKey) {
  const info = state.threads.get(threadKey);
  if (info && info.aliasFor && !info.ambiguous) threadKey = info.aliasFor;
  state.currentThread = threadKey;
  showView('chats', false);
  history.replaceState(null, '', '#thread=' + encodeURIComponent(threadKey));
  renderThreadList();
  await renderThread(focusKey);
}

async function renderSearch(q) {
  revokeUrls();
  $('#search-title').textContent = `Results for “${q}”`;
  const list = $('#search-list');
  list.textContent = '';
  const items = await db.searchMessages(q, { limit: 300 });
  if (!items.length) return list.appendChild(emptyState('No saved message contains that.'));
  for (const m of items) list.appendChild(messageCard(m));
}

/* ---------------- settings view ---------------- */

function applySettings(s) {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!s[key];
    else if (document.activeElement !== input) input.value = s[key];
  }
  // switches that cannot do anything in the current state are shown as off-limits
  const strong = document.querySelector('#view-settings [data-setting="stealthFocus"]');
  const hidden = document.querySelector('#view-settings [data-setting="stealthVisibility"]');
  if (strong) strong.disabled = !s.blockSeen;
  if (hidden) hidden.disabled = !s.blockSeen || !s.stealthFocus;
  document.body.classList.toggle('paused', !s.enabled);
  $('#paused-banner').hidden = !!s.enabled;
}

async function bindSettings() {
  applySettings(await getSettings());
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    input.addEventListener('change', async () => {
      const value = input.type === 'checkbox' ? input.checked : Math.max(Number(input.min || 0), Math.min(Number(input.max || 1e9), Number(input.value) || 0));
      if (input.type !== 'checkbox') input.value = value;
      await setSettings({ [key]: value });
      toast('Saved');
    });
  }
  // changes made in the popup or with Alt+Shift+U show up here at once
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) getSettings().then(applySettings);
  });
}

async function renderDiagnostics() {
  const box = $('#diag');
  const all = await chrome.storage.session.get(null);
  const { stats = {} } = await chrome.storage.local.get('stats');
  const rows = Object.entries(all).filter(([k]) => k.startsWith('diag:'));
  const table = el('table');
  table.appendChild(el('tr', {}, el('th', { text: 'Tab' }), el('th', { text: 'Gateway sockets' }), el('th', { text: 'Network messages' }), el('th', { text: 'On-screen' }), el('th', { text: 'Seen / typing blocked' }), el('th', { text: 'Problems' })));
  for (const [, d] of rows) {
    const sockets = d.sockets || {};
    table.appendChild(
      el(
        'tr',
        {},
        el('td', { text: (d.url || '').replace(/^https:\/\//, '').slice(0, 60) + ' · ' + fmtAgo(d.at) }),
        el('td', { text: `${sockets.dgw || 0} gateway, ${sockets.mqtt || 0} legacy, ${sockets.e2ee || 0} encrypted` }),
        el('td', { text: `${d.messages || 0} msgs, ${d.unsent || 0} unsends, ${d.edits || 0} edits` }),
        el('td', { text: d.dom ? `${d.dom.logs} chat(s) open, ${d.dom.saved} saved, ${d.dom.recovered} shown` : '-' }),
        el('td', { text: `${d.seenBlocked || 0} / ${d.typingBlocked || 0}` + (d.seenUnknown ? ` (${d.seenUnknown} not held back: reload this tab)` : '') + (d.lateInjected ? ' · started late: reload this tab' : '') }),
        el('td', { text: d.errors ? `${d.errors}: ${d.lastError}` : 'none' })
      )
    );
  }
  box.textContent = '';
  if (!rows.length) box.appendChild(el('p', { class: 'muted', text: 'No Facebook or Messenger tab has reported yet. Open (or reload) one.' }));
  else box.appendChild(el('div', { class: 'table-scroll' }, table));
  box.appendChild(el('p', { class: 'muted small', text: `Since install: ${stats.seenBlocked || 0} “Seen” and ${stats.typingBlocked || 0} “typing” signals blocked in normal chats.` }));
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function stamp() {
  return localStamp(Date.now()).replace(/[: ]/g, '-');
}

async function exportJson(includeMedia) {
  try {
    toast('Preparing backup…');
    const { blob, photos } = await db.exportBlob({ includeMedia });
    download(`messenger-saved-${stamp()}.json`, blob);
    toast(includeMedia ? `Backup ready (${photos} photos)` : 'Backup ready');
  } catch (e) {
    toast('Backup failed: ' + e.message);
  }
}

/** "2026-11-14 15:00" in the computer's own time zone (Excel reads it as a date). */
function localStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function csvCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  // a cell starting with = + - @ would run as a formula in Excel or Google Sheets
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv(threadKey) {
  const msgs = threadKey ? await db.messagesByThreadMerged(threadKey) : (await db.getAll('messages')).sort((a, b) => a.ts - b.ts);
  const lines = [['chat', 'sender', 'time', 'status', 'text', 'earlier_versions', 'unsent_at', 'attachments'].join(',')];
  for (const m of msgs) {
    const tName = nameOfThread(m.threadKey);
    lines.push(
      [
        tName,
        senderOf(m, state.contacts, tName),
        localStamp(m.ts),
        m.status,
        m.text || '',
        (m.history || []).map((h) => h.text).join(' | '),
        m.unsentAt ? localStamp(m.unsentAt) : '',
        (m.attachments || []).map((a) => a.title || a.filename || a.previewUrl || '').join(' | '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  download(`messenger-saved-${threadKey ? 'chat-' : ''}${stamp()}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve('');
    fr.readAsDataURL(blob);
  });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function exportHtml() {
  toast('Preparing page…');
  const msgs = (await db.getAll('messages')).sort((a, b) => a.ts - b.ts);
  const byThread = new Map();
  for (const m of msgs) {
    const info = threadInfo(m.threadKey);
    const k = info.threadKey;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(m);
  }
  const parts = [];
  let photoBudget = 40 * 1024 * 1024; // photos of unsent/deleted messages are embedded, up to 40 MB
  for (const [k, list] of byThread) {
    const tName = nameOfThread(k);
    parts.push(`<h2>${esc(tName)}</h2>`);
    for (const m of list) {
      const cls = m.unsent || m.deleted ? 'u' : m.edited ? 'e' : '';
      const tags = [m.unsent ? 'UNSENT' : '', m.deleted ? 'DELETED' : '', m.edited ? 'EDITED' : ''].filter(Boolean).join(' ');
      const hist = (m.history || []).map((h) => `<div class="h">before: ${esc(h.text)}</div>`).join('');
      const atts = [];
      for (const a of m.attachments || []) {
        const media = a.mediaKey && (m.unsent || m.deleted) ? await db.getMedia(a.mediaKey) : null;
        if (media && media.blob && media.blob.size <= photoBudget) {
          photoBudget -= media.blob.size;
          atts.push(`<img class="p" alt="" src="${await blobToDataUrl(media.blob)}">`);
        } else atts.push(`<div class="a">📎 ${esc(a.title || a.filename || (a.mediaKey ? 'photo (in the JSON backup)' : 'attachment'))}</div>`);
      }
      const body = m.text ? esc(m.text) : m.unsent && !hasContent(m) ? '<i>Unsent before it could be saved.</i>' : '';
      parts.push(`<div class="m ${cls}"><div class="t">${esc(senderOf(m, state.contacts, tName))} · ${esc(new Date(m.ts).toLocaleString())} ${tags ? `<b>${tags}</b>` : ''}</div><div>${body}</div>${hist}${atts.join('')}</div>`);
    }
  }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved Messenger messages</title><style>body{font:14px system-ui,sans-serif;max-width:860px;margin:20px auto;padding:0 12px}h2{border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:28px}.m{padding:6px 10px;margin:4px 0;border-radius:8px;background:#f3f4f6;white-space:pre-wrap;overflow-wrap:anywhere}.m.u{background:#fde8ee;border-left:4px solid #e0245e}.m.e{border-left:4px solid #0a7cff}.t{font-size:12px;color:#555}.h{font-size:12px;color:#0a7cff}.a{font-size:12px;color:#555}.p{display:block;max-width:100%;max-height:360px;margin-top:6px;border-radius:6px}</style><h1>Saved Messenger messages</h1><p>Exported ${esc(new Date().toLocaleString())} by Messenger Message Saver.</p>${parts.join('\n')}`;
  download(`messenger-saved-${stamp()}.html`, new Blob([html], { type: 'text/html' }));
}

async function importJson(file) {
  try {
    toast('Restoring…');
    const counts = await db.importFile(file, (c) => toast(`Restoring… ${c.media} photos so far`));
    toast(`Restored ${counts.messages} messages, ${counts.media} photos`);
    await refreshAll();
  } catch (e) {
    toast('Restore failed: ' + e.message);
  }
}

function confirmDialog(text, okLabel = 'Delete') {
  const dlg = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/* ---------------- shell ---------------- */

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const VIEWS = ['unsent', 'chats', 'edited', 'search', 'notifications', 'settings', 'help'];

function showView(name, updateHash = true) {
  for (const v of VIEWS) {
    const sec = $('#view-' + v);
    if (sec) sec.hidden = v !== name;
  }
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === name));
  if (updateHash && name !== 'search') history.replaceState(null, '', '#' + name);
  if (name === 'unsent') renderUnsent();
  else if (name === 'edited') renderEdited();
  else if (name === 'notifications') renderNotifications();
  else if (name === 'settings') renderDiagnostics();
  else if (name === 'chats') {
    renderThreadList();
    if (!state.currentThread) renderThread();
  }
}

/** Takes deleted data off the screen: 'all', or a list of chat keys. */
async function forgetOnScreen(deleted) {
  const all = deleted === 'all';
  if (all || (state.currentThread && deleted.includes(state.currentThread))) {
    state.currentThread = null;
    if (location.hash.startsWith('#thread=')) history.replaceState(null, '', '#chats');
    await renderThread();
  }
  if (all) {
    revokeUrls();
    for (const id of ['#unsent-list', '#edited-list', '#search-list', '#notification-list']) $(id).textContent = '';
  }
  await refreshAll();
  const q = $('#search').value.trim();
  if (!$('#view-search').hidden && q.length >= 2) await renderSearch(q);
}

async function refreshAll() {
  await loadBasics();
  const active = VIEWS.find((v) => !$('#view-' + v).hidden) || 'unsent';
  if (active === 'chats') {
    renderThreadList();
    if (state.currentThread) await renderThread();
  } else showView(active, false);
}

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash.startsWith('thread=')) {
    const params = new URLSearchParams(location.hash.slice(1));
    openThread(params.get('thread'), params.get('msg'));
    return;
  }
  if (hash === 'welcome') {
    $('#welcome').hidden = false;
    showView('unsent', false);
    return;
  }
  showView(VIEWS.includes(hash) ? hash : 'unsent', false);
}

async function init() {
  await loadBasics();
  await bindSettings();
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
  for (const c of document.querySelectorAll('#msg-filter .chip'))
    c.addEventListener('click', () => {
      document.querySelectorAll('#msg-filter .chip').forEach((x) => x.classList.toggle('on', x === c));
      state.msgFilter = c.dataset.f;
      renderThread();
    });
  for (const c of document.querySelectorAll('#unsent-filter .chip'))
    c.addEventListener('click', () => {
      document.querySelectorAll('#unsent-filter .chip').forEach((x) => x.classList.toggle('on', x === c));
      state.unsentFilter = c.dataset.f;
      renderUnsent();
    });
  $('#thread-filter').addEventListener('input', renderThreadList);
  let searchTimer = 0;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
      if (q.length >= 2) {
        showView('search', false);
        renderSearch(q);
      } else if (!q) showView('unsent');
    }, 250);
  });
  $('#welcome-close').addEventListener('click', () => {
    $('#welcome').hidden = true;
    history.replaceState(null, '', '#unsent');
  });
  $('#export-json').addEventListener('click', () => exportJson(true));
  $('#export-json-light').addEventListener('click', () => exportJson(false));
  const guarded = (fn) => () => fn().catch((e) => toast('Export failed: ' + e.message));
  $('#export-html').addEventListener('click', guarded(exportHtml));
  $('#export-csv').addEventListener('click', guarded(() => exportCsv(null)));
  $('#export-thread').addEventListener('click', guarded(() => (state.currentThread ? exportCsv(state.currentThread) : Promise.resolve())));
  $('#import-json').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // so choosing the same file again works
    if (file) await importJson(file);
  });
  $('#delete-thread').addEventListener('click', async () => {
    if (!state.currentThread) return;
    if (!(await confirmDialog(`Delete everything saved from “${nameOfThread(state.currentThread)}”: messages, photos, unsend and edit history, and Messenger notification copies from this chat? This cannot be undone.`))) return;
    const name = nameOfThread(state.currentThread);
    const keys = await db.threadKeysFor(state.currentThread);
    for (const k of keys) await db.deleteThread(k, { name });
    dataChannel.postMessage({ deleted: keys });
    state.currentThread = null;
    history.replaceState(null, '', '#chats');
    await renderThread(); // the deleted conversation must not stay on screen
    toast('Chat data deleted');
    await refreshAll();
  });
  $('#delete-all').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete ALL saved messages, photos and history? This cannot be undone. (Tip: download a backup first.)', 'Delete everything'))) return;
    await db.clearAll();
    await chrome.storage.local.set({ stats: {} });
    dataChannel.postMessage({ deleted: 'all' });
    await forgetOnScreen('all');
    toast('Everything deleted');
  });
  // deletions made in another Saved Messages tab, or old messages removed by the retention setting
  dataChannel.onmessage = (e) => {
    const d = e.data || {};
    if (d.deleted) forgetOnScreen(d.deleted).catch(() => {});
    else if (d.pruned) refreshAll().catch(() => {});
  };
  window.addEventListener('hashchange', route);
  route();
  chrome.runtime.sendMessage({ type: 'badge-seen' }).catch(() => {});
  // keep counts and lists fresh while the page is open, without jumping around
  let lastTotals = JSON.stringify(await db.quickTotals());
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const now = JSON.stringify(await db.quickTotals()); // cheap: index counts only
      if (now === lastTotals) return;
      lastTotals = now;
      await loadBasics();
      if (!$('#view-unsent').hidden) await renderUnsent();
      else if (!$('#view-edited').hidden) await renderEdited();
      else if (!$('#view-chats').hidden) renderThreadList();
    } catch (e) {
      /* ignore */
    }
  }, 10000);
}

init().catch((e) => {
  console.error(e);
  toast('Error: ' + e.message);
});
