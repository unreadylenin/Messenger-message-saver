import { getSettings, setSettings } from '../lib/settings.js';
import * as db from '../lib/db.js';
import { el, fmtTime, fmtAgo, senderOf, threadTitle } from '../lib/format.js';

const $ = (sel) => document.querySelector(sel);

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
  const [contacts, threads, summary] = await Promise.all([db.getContactsMap(), db.getAll('threads'), db.summarize()]);
  state.contacts = contacts;
  state.threads = new Map(threads.map((t) => [t.threadKey, t]));
  state.summary = summary;
  const t = summary.totals;
  $('#totals-line').textContent = `${t.messages} messages saved · ${t.unsent} unsent kept · ${t.edited} edited · ${t.media} photos`;
  $('#c-unsent').textContent = t.unsent ? String(t.unsent) : '';
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
  const box = el('div', { class: 'lightbox', onclick: () => box.remove() }, el('img', { src, alt: '' }));
  document.body.appendChild(box);
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
          img.addEventListener('click', () => openLightbox(u));
        } else img.remove();
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
      who !== tName ? el('span', { class: 'chat', text: 'in ' + tName, title: 'Open this chat', onclick: () => openThread(m.threadKey, m.key) }) : el('span', { class: 'chat', text: 'open chat', onclick: () => openThread(m.threadKey, m.key) }),
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
  const [unsent, deleted] = await Promise.all([db.messagesByStatus('unsent', 2000), db.messagesByStatus('deleted', 2000)]);
  let items = [...unsent, ...deleted].sort((a, b) => (b.unsentAt || b.deletedAt || b.ts) - (a.unsentAt || a.deletedAt || a.ts));
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
      { class: state.currentThread === t.threadKey ? 'on' : '', dataset: { key: t.threadKey }, onclick: () => openThread(t.threadKey) },
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
  } else box.lastElementChild && box.lastElementChild.scrollIntoView({ block: 'end' });
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

async function bindSettings() {
  const s = await getSettings();
  for (const input of document.querySelectorAll('#view-settings [data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!s[key];
    else input.value = s[key];
    input.addEventListener('change', async () => {
      const value = input.type === 'checkbox' ? input.checked : Math.max(Number(input.min || 0), Math.min(Number(input.max || 1e9), Number(input.value) || 0));
      if (input.type !== 'checkbox') input.value = value;
      await setSettings({ [key]: value });
      toast('Saved');
    });
  }
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
        el('td', { text: `${d.seenBlocked || 0} / ${d.typingBlocked || 0}` }),
        el('td', { text: d.errors ? `${d.errors}: ${d.lastError}` : 'none' })
      )
    );
  }
  box.textContent = '';
  if (!rows.length) box.appendChild(el('p', { class: 'muted', text: 'No Facebook or Messenger tab has reported yet. Open (or reload) one.' }));
  else box.appendChild(table);
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
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

async function exportJson(includeMedia) {
  toast('Preparing backup…');
  const data = await db.exportAll({ includeMedia });
  download(`messenger-saved-${stamp()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
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
        new Date(m.ts).toISOString(),
        m.status,
        m.text || '',
        (m.history || []).map((h) => h.text).join(' | '),
        m.unsentAt ? new Date(m.unsentAt).toISOString() : '',
        (m.attachments || []).map((a) => a.title || a.filename || a.previewUrl || '').join(' | '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  download(`messenger-saved-${threadKey ? 'chat-' : ''}${stamp()}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
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
  for (const [k, list] of byThread) {
    const tName = nameOfThread(k);
    parts.push(`<h2>${esc(tName)}</h2>`);
    for (const m of list) {
      const cls = m.unsent || m.deleted ? 'u' : m.edited ? 'e' : '';
      const tags = [m.unsent ? 'UNSENT' : '', m.deleted ? 'DELETED' : '', m.edited ? 'EDITED' : ''].filter(Boolean).join(' ');
      const hist = (m.history || []).map((h) => `<div class="h">before: ${esc(h.text)}</div>`).join('');
      const atts = (m.attachments || []).map((a) => `<div class="a">📎 ${esc(a.title || a.filename || 'attachment')}</div>`).join('');
      parts.push(`<div class="m ${cls}"><div class="t">${esc(senderOf(m, state.contacts, tName))} · ${esc(new Date(m.ts).toLocaleString())} ${tags ? `<b>${tags}</b>` : ''}</div><div>${esc(m.text || '')}</div>${hist}${atts}</div>`);
    }
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Saved Messenger messages</title><style>body{font:14px system-ui,sans-serif;max-width:860px;margin:20px auto;padding:0 12px}h2{border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:28px}.m{padding:6px 10px;margin:4px 0;border-radius:8px;background:#f3f4f6;white-space:pre-wrap}.m.u{background:#fde8ee;border-left:4px solid #e0245e}.m.e{border-left:4px solid #0a7cff}.t{font-size:12px;color:#555}.h{font-size:12px;color:#0a7cff}.a{font-size:12px;color:#555}</style><h1>Saved Messenger messages</h1><p>Exported ${esc(new Date().toLocaleString())} by Messenger Message Saver.</p>${parts.join('\n')}`;
  download(`messenger-saved-${stamp()}.html`, new Blob([html], { type: 'text/html' }));
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const counts = await db.importAll(data);
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
  $('#export-html').addEventListener('click', exportHtml);
  $('#export-csv').addEventListener('click', () => exportCsv(null));
  $('#export-thread').addEventListener('click', () => state.currentThread && exportCsv(state.currentThread));
  $('#import-json').addEventListener('change', (e) => e.target.files[0] && importJson(e.target.files[0]));
  $('#delete-thread').addEventListener('click', async () => {
    if (!state.currentThread) return;
    if (!(await confirmDialog(`Delete everything saved from “${nameOfThread(state.currentThread)}”? This cannot be undone.`))) return;
    for (const k of await db.threadKeysFor(state.currentThread)) await db.deleteThread(k);
    state.currentThread = null;
    toast('Chat data deleted');
    await refreshAll();
  });
  $('#delete-all').addEventListener('click', async () => {
    if (!(await confirmDialog('Delete ALL saved messages, photos and history? This cannot be undone. (Tip: download a backup first.)', 'Delete everything'))) return;
    await db.clearAll();
    await chrome.storage.local.set({ stats: {} });
    toast('Everything deleted');
    await refreshAll();
  });
  window.addEventListener('hashchange', route);
  route();
  chrome.runtime.sendMessage({ type: 'badge-seen' }).catch(() => {});
  // keep counts and lists fresh while the page is open, without jumping around
  let lastTotals = JSON.stringify(state.summary.totals);
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      await loadBasics();
      const now = JSON.stringify(state.summary.totals);
      if (now === lastTotals) return;
      lastTotals = now;
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
