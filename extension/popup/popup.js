import { DEFAULT_SETTINGS, getSettings, setSettings } from '../lib/settings.js';
import * as db from '../lib/db.js';
import { fmtAgo, el, senderOf, threadTitle } from '../lib/format.js';

const $ = (sel) => document.querySelector(sel);

async function bindToggles() {
  const s = await getSettings();
  for (const input of document.querySelectorAll('input[data-setting]')) {
    const key = input.dataset.setting;
    input.checked = !!s[key];
    input.addEventListener('change', async () => {
      const next = await setSettings({ [key]: input.checked });
      reflect(next);
    });
  }
  reflect(s);
}

function reflect(s) {
  const stealthRow = $('#row-stealth');
  const stealthInput = stealthRow.querySelector('input');
  stealthInput.disabled = !s.blockSeen;
  stealthRow.classList.toggle('disabled', !s.blockSeen);
  const parts = [];
  if (!s.enabled) parts.push('Paused');
  else {
    parts.push(s.saveMessages ? 'Saving' : 'Not saving');
    if (s.blockSeen) parts.push('Unseen on');
  }
  $('#state-line').textContent = parts.join(' · ');
  document.body.classList.toggle('paused', !s.enabled);
}

async function showStats() {
  const [totals, { stats = {} }] = await Promise.all([db.quickTotals(), chrome.storage.local.get('stats')]);
  $('#s-messages').textContent = totals.messages;
  $('#s-unsent').textContent = totals.unsent;
  $('#s-edited').textContent = totals.edited;
  $('#s-seen').textContent = stats.seenBlocked || 0;
}

async function showRecent() {
  const list = $('#recent-list');
  const [unsent, contacts, threads] = await Promise.all([db.messagesByStatus('unsent', 30), db.getContactsMap(), db.getAll('threads')]);
  const threadMap = new Map(threads.map((t) => [t.threadKey, t]));
  const items = unsent.filter((m) => (m.text && m.text.trim()) || (m.attachments && m.attachments.length)).slice(0, 5);
  list.textContent = '';
  $('#recent-empty').hidden = items.length > 0;
  for (const m of items) {
    const tName = threadTitle(threadMap.get(m.threadKey) || { threadKey: m.threadKey }, contacts);
    const who = senderOf(m, contacts, tName);
    const li = el(
      'li',
      { title: 'Open in saved messages' },
      el('span', { class: 'when', text: fmtAgo(m.unsentAt || m.ts) }),
      el('div', { class: 'who', text: who === tName ? who : `${who} · ${tName}` }),
      el('div', { class: 'txt', text: m.text || '[photo / attachment]' })
    );
    li.addEventListener('click', () => openDashboard('#thread=' + encodeURIComponent(m.threadKey) + '&msg=' + encodeURIComponent(m.key)));
    list.appendChild(li);
  }
}

async function checkActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https:\/\/(www|web)\.(facebook|messenger)\.com\//.test(tab.url)) return;
  const key = 'diag:' + tab.id;
  let diag = (await chrome.storage.session.get(key))[key];
  if (!diag) {
    // give a freshly loaded page a moment to report in
    await new Promise((r) => setTimeout(r, 1200));
    diag = (await chrome.storage.session.get(key))[key];
  }
  const s = await getSettings();
  let text = '';
  if (!diag) text = 'Reload this Facebook tab once so the extension can start working here.';
  else if (diag.lateInjected && s.blockSeen) text = 'This tab was open before the extension started. Reload it so Unseen covers every chat.';
  else if (diag.seenUnknown > 0 && s.blockSeen) text = '“Seen” may have been sent in a chat whose read state was not known yet. Reload this tab to be safe.';
  if (!text) return;
  $('#reload-text').textContent = text;
  $('#reload-hint').hidden = false;
  $('#reload-tab').addEventListener('click', () => {
    chrome.tabs.reload(tab.id);
    window.close();
  });
}

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html' + hash) });
  window.close();
}

$('#open-dashboard').addEventListener('click', () => openDashboard());
$('#open-settings').addEventListener('click', () => openDashboard('#settings'));

bindToggles();
showStats().catch(console.error);
showRecent().catch(console.error);
checkActiveTab().catch(() => {});
chrome.runtime.sendMessage({ type: 'badge-seen' }).catch(() => {});
void DEFAULT_SETTINGS;
