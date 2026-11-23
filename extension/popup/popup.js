import { getSettings, setSettings } from '../lib/settings.js';
import * as db from '../lib/db.js';
import * as lock from '../lib/lock.js';
import { fmtAgo, el, senderOf, threadTitle, t, lang, setUiLanguage, applyI18n, fmtNum } from '../lib/format.js';

const $ = (sel) => document.querySelector(sel);
let locked = false; // PIN lock on and this browser session not unlocked

async function bindToggles() {
  const s = await getSettings();
  for (const input of document.querySelectorAll('input[data-setting]')) {
    const key = input.dataset.setting;
    input.checked = !!s[key];
    input.addEventListener('change', async () => {
      // while locked, the in-chat copies of unsent messages can be hidden but not shown again
      if (locked && key === 'showRecoveredInline' && input.checked) {
        input.checked = false;
        return;
      }
      const next = await setSettings({ [key]: input.checked });
      reflect(next);
    });
  }
  reflect(s);
}

function reflect(s) {
  const stealthRow = $('#row-stealth');
  const stealthInput = stealthRow.querySelector('input');
  stealthInput.disabled = !s.enabled || !s.blockSeen;
  stealthRow.classList.toggle('disabled', !s.blockSeen);
  // while paused, every feature is off: show it, and do not let the switches pretend otherwise
  for (const input of document.querySelectorAll('.toggles input[data-setting]')) if (input.dataset.setting !== 'stealthFocus') input.disabled = !s.enabled;
  const inline = document.querySelector('.toggles input[data-setting="showRecoveredInline"]');
  if (inline && locked && !s.showRecoveredInline) inline.disabled = true;
  $('#paused-note').hidden = !!s.enabled;
  const parts = [];
  if (!s.enabled) parts.push(t('state.paused'));
  else {
    parts.push(t(s.saveMessages ? 'state.saving' : 'state.notSaving'));
    if (s.blockSeen) parts.push(t('state.unseenOn'));
  }
  if (locked) parts.push('🔒 ' + t('state.locked'));
  $('#state-line').textContent = parts.join(' · ');
  document.body.classList.toggle('paused', !s.enabled);
}

async function showStats() {
  const { stats = {} } = await chrome.storage.local.get('stats');
  $('#s-seen').textContent = fmtNum(stats.seenBlocked || 0);
  if (locked) {
    for (const id of ['#s-messages', '#s-unsent', '#s-edited']) $(id).textContent = '–';
    return;
  }
  const totals = await db.quickTotals();
  $('#s-messages').textContent = fmtNum(totals.messages);
  $('#s-unsent').textContent = fmtNum(totals.unsent); // unsent messages whose content was kept
  $('#s-edited').textContent = fmtNum(totals.edited);
}

async function showRecent() {
  const list = $('#recent-list');
  list.textContent = '';
  if (locked) {
    $('#recent-empty').hidden = true;
    $('#recent-locked').hidden = false;
    return;
  }
  const [unsent, contacts, threads] = await Promise.all([db.messagesByStatus('unsent', 30), db.getContactsMap(), db.getAll('threads')]);
  const threadMap = new Map(threads.map((th) => [th.threadKey, th]));
  const items = unsent.filter((m) => (m.text && m.text.trim()) || (m.attachments && m.attachments.length)).slice(0, 3);
  $('#recent-empty').hidden = items.length > 0;
  for (const m of items) {
    const tName = threadTitle(threadMap.get(m.threadKey) || { threadKey: m.threadKey }, contacts);
    const who = senderOf(m, contacts, tName);
    const li = el(
      'li',
      { title: t('popup.openIn'), tabindex: '0', role: 'button' },
      el('span', { class: 'when', text: fmtAgo(m.unsentAt || m.ts) }),
      el('div', { class: 'who', text: who === tName ? who : `${who} · ${tName}` }),
      el('div', { class: 'txt', text: m.text || t('att.photoOrAttachment') })
    );
    const open = () => openDashboard('#thread=' + encodeURIComponent(m.threadKey) + '&msg=' + encodeURIComponent(m.key));
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
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
  if (!diag) text = t('hint.reload');
  else if (diag.lateInjected && s.blockSeen) text = t('hint.late');
  else if (diag.seenUnknown > 0 && s.blockSeen) text = t('hint.seenUnknown');
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

function bindLanguage() {
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.classList.toggle('on', b.dataset.lang === lang());
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang()));
    b.addEventListener('click', async () => {
      if (b.dataset.lang === lang()) return;
      await setSettings({ uiLanguage: b.dataset.lang });
      location.reload();
    });
  }
}

async function start() {
  const s = await getSettings();
  setUiLanguage(s.uiLanguage);
  applyI18n(document);
  bindLanguage();
  locked = (await lock.isLockOn()) && !(await lock.isUnlocked());
  $('#open-dashboard').addEventListener('click', () => openDashboard());
  $('#open-settings').addEventListener('click', () => openDashboard('#settings'));
  await bindToggles();
  showStats().catch(console.error);
  showRecent().catch(console.error);
  checkActiveTab().catch(() => {});
  if (!locked) chrome.runtime.sendMessage({ type: 'badge-seen' }).catch(() => {});
}

start().catch(console.error);
