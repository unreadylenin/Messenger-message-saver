/*
 * Messenger Message Saver - content script (extension's private "isolated world").
 *
 * 1. Passes settings to the page hook (main-world.js) and forwards what it captures
 *    to the background worker.
 * 2. Reads the messages shown on screen (chat pop-ups on facebook.com, the full
 *    facebook.com/messages page and messenger.com). This also works for end-to-end
 *    encrypted chats, whose network traffic cannot be read.
 * 3. Under every "X unsent a message" it shows the saved original, and under edited
 *    messages it shows the earlier text.
 *
 * Page structure used (checked against live captures, Oct-Nov 2026):
 *   message list  : [role="log"]
 *   message row   : [data-scope="messages_table"] with aria-roledescription="message",
 *                   data-message-id="<sender id>@msgr.<id>", aria-label="At <time>, <Sender>: <text>"
 *   date separator: [data-scope="date_break"]
 *   text          : span[dir="auto"] > div[dir="auto"] (emoji are <img alt="😀">)
 *   chat window   : [data-mw-file-dropzone] with the chat name in the heading above the log
 * Facebook's CSS class names are never used: they change every few weeks.
 */
(() => {
  'use strict';

  // One live copy per tab. After the extension is updated, reloaded or re-enabled, the
  // background worker injects a fresh copy; an old copy whose extension context is gone
  // steps aside (and stops itself, see invalidated()).
  const runtimeRef = chrome.runtime;
  const instance = { id: Math.random().toString(36).slice(2), t: Date.now() };
  const prev = window.__mmsContent;
  if (prev && typeof prev.alive === 'function' && prev.alive()) return;
  if (prev && typeof prev.stop === 'function') {
    try {
      prev.stop();
    } catch (e) {
      /* already gone */
    }
  }

  const CHANNEL_OUT = '__mms_page_to_ext__'; // page hook -> here
  const CHANNEL_IN = '__mms_ext_to_page__'; // here -> page hook

  const DEFAULT_SETTINGS = {
    enabled: true,
    saveMessages: true,
    captureNetwork: true,
    captureDom: true,
    captureNotifications: true,
    saveMedia: true,
    maxMediaMB: 15,
    retentionDays: 0,
    showRecoveredInline: true,
    showEditHistoryInline: true,
    notifyOnUnsend: true,
    notifyOnEdit: false,
    badge: true,
    blockSeen: true,
    stealthFocus: true,
    stealthVisibility: false,
    blockTyping: true,
  };

  let settings = { ...DEFAULT_SETTINGS };
  let extensionAlive = true;
  const domStats = { logs: 0, rows: 0, saved: 0, placeholders: 0, recovered: 0 };
  const cleanups = []; // observers and timers to stop if this copy is retired

  function runtimeAlive() {
    try {
      return !!(runtimeRef && runtimeRef.id);
    } catch (e) {
      return false;
    }
  }

  window.__mmsContent = {
    alive: () => extensionAlive && runtimeAlive(),
    stop: () => invalidated(true),
  };

  /* ---------------- talking to the background worker ---------------- */

  function isInvalidation(e) {
    return /context invalidated/i.test(String((e && e.message) || e)) || !runtimeAlive();
  }

  function send(msg) {
    if (!extensionAlive) return Promise.resolve(null);
    try {
      return runtimeRef.sendMessage(msg).catch((e) => {
        if (isInvalidation(e)) invalidated(false);
        return null;
      });
    } catch (e) {
      // e.g. "Message exceeded maximum allowed size": drop this message, keep working
      if (isInvalidation(e)) invalidated(false);
      else console.debug('[MMS] message not sent', e && e.message);
      return Promise.resolve(null);
    }
  }

  /**
   * The extension was updated, reloaded, disabled or removed: stop this copy and give the
   * page back to Facebook's normal behaviour (a newer copy, if any, takes over the page hook).
   */
  function invalidated(replaced) {
    if (!extensionAlive) return;
    extensionAlive = false;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {
        /* ignore */
      }
    }
    if (!replaced) {
      document.querySelectorAll('.mms-recovered, .mms-edit-history').forEach((el) => el.remove());
      document.dispatchEvent(new CustomEvent(CHANNEL_IN, { detail: JSON.stringify({ type: 'settings', inst: instance, data: { enabled: false } }) }));
    }
  }

  const aliveTimer = setInterval(() => {
    if (!runtimeAlive()) invalidated(false);
  }, 5000);
  cleanups.push(() => clearInterval(aliveTimer));

  function selfId() {
    const m = /(?:^|;\s*)c_user=(\d+)/.exec(document.cookie || '');
    return m ? m[1] : '';
  }

  /* ---------------- settings -> page hook ---------------- */

  function pushSettingsToPage() {
    const forPage = {
      enabled: settings.enabled,
      captureNetwork: settings.enabled && settings.saveMessages && settings.captureNetwork,
      captureNotifications: settings.enabled && settings.saveMessages && settings.captureNotifications,
      blockSeen: settings.enabled && settings.blockSeen,
      blockTyping: settings.enabled && settings.blockTyping,
      stealthFocus: settings.enabled && settings.blockSeen && settings.stealthFocus,
      stealthVisibility: settings.enabled && settings.blockSeen && settings.stealthFocus && settings.stealthVisibility,
    };
    if (!extensionAlive) return;
    document.dispatchEvent(new CustomEvent(CHANNEL_IN, { detail: JSON.stringify({ type: 'settings', inst: instance, data: forPage }) }));
  }

  chrome.storage.local.get('settings').then(({ settings: stored }) => {
    settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    pushSettingsToPage();
    startDom();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    pushSettingsToPage();
    if (!settings.enabled || !settings.showRecoveredInline) removeInline('.mms-recovered');
    if (!settings.enabled || !settings.showEditHistoryInline) removeInline('.mms-edit-history');
    scheduleFullScan();
  });

  /* ---------------- page hook -> background ---------------- */

  let lsBuffer = null;
  let lsTimer = 0;

  function mergeEvents(into, ev) {
    for (const k of Object.keys(ev)) {
      if (Array.isArray(ev[k])) {
        if (!into[k]) into[k] = [];
        into[k].push(...ev[k]);
      }
    }
  }

  function flushLs() {
    lsTimer = 0;
    if (!lsBuffer) return;
    const events = lsBuffer;
    lsBuffer = null;
    send({ type: 'ingest-ls', events, ctx: { selfId: selfId(), url: location.href } });
  }

  const onPageMessage = (e) => {
    let m;
    try {
      m = JSON.parse(String(e.detail));
    } catch (err) {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ls-events':
        if (!settings.enabled || !settings.saveMessages) return;
        lsBuffer = lsBuffer || {};
        mergeEvents(lsBuffer, m.data || {});
        if (!lsTimer) lsTimer = setTimeout(flushLs, 250);
        break;
      case 'notification':
        if (settings.enabled && settings.saveMessages && settings.captureNotifications) send({ type: 'ingest-notification', notification: m.data });
        break;
      case 'unseen-actions':
        send({ type: 'unseen-actions', actions: m.data });
        break;
      case 'diag':
        send({ type: 'diag', diag: { ...(m.data || {}), dom: domStats } });
        break;
      default:
        break;
    }
  };
  document.addEventListener(CHANNEL_OUT, onPageMessage);
  cleanups.push(() => document.removeEventListener(CHANNEL_OUT, onPageMessage));

  // The page hook buffers until it gets settings; send defaults right away so nothing
  // waits on storage (real settings follow a few milliseconds later).
  pushSettingsToPage();

  /* ================================================================== */
  /* On-screen capture                                                  */
  /* ================================================================== */

  // Placeholder text Messenger shows instead of an unsent / removed message.
  // Seen live in 2026: "Alpha deleted a message", "You deleted a message"; Meta's own strings:
  // "You unsent a message", "<first name> unsent a message", "A poll has been unsent."
  const PLACEHOLDER_PATTERNS = [
    /^(?:you|.{1,80}?) (?:unsent|deleted|removed) (?:a|an|this) (?:message|attachment|photo|video|voice message|poll)\.?$/i,
    /^this message (?:was|has been) (?:unsent|deleted|removed)\.?$/i,
    /^message (?:unsent|deleted|removed)\.?$/i,
    /^a poll has been unsent\.?$/i,
    /^(?:bạn|.{1,80}?) đã (?:thu hồi|xóa|xoá) (?:một )?tin nhắn\.?$/i, // Vietnamese
    /^.{1,80}? (?:cofnął|cofnęła|cofnęłaś|cofnąłeś) wysłanie wiadomości\.?$/i, // Polish
    /একটি (?:বার্তা|মেসেজ) (?:মুছে ফেলেছেন|আনসেন্ড করেছেন|সরিয়ে দিয়েছেন|সরিয়েছেন)/, // Bangla
    /^এই (?:বার্তাটি|মেসেজটি) (?:মুছে ফেলা হয়েছে|সরানো হয়েছে|আনসেন্ড করা হয়েছে)/,
    /(?:a annulé l’envoi d’un message|hat eine Nachricht zurückgerufen|anuló el envío de un mensaje|retirou o envio de uma mensagem|ha annullato l'invio di un messaggio|membatalkan pengiriman pesan)/i,
  ];
  let learnedPlaceholders = []; // RegExps learned on this computer for other UI languages

  const EDITED_LABELS = new Set(['edited', 'hide edits', 'edytowano', 'সম্পাদিত', 'modifié', 'bearbeitet', 'editado', 'modificato', 'diedit', 'đã chỉnh sửa']);
  const YOU_LABELS = new Set(['you', 'ty', 'আপনি', 'vous', 'du', 'tú', 'tu', 'você', 'anda', 'bạn']);
  const YOU_HEADINGS = /^(?:you sent|you replied to|wysłano|bạn đã gửi|আপনি পাঠিয়েছেন)\b/i;

  function isPlaceholderText(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 140) return false;
    return PLACEHOLDER_PATTERNS.some((re) => re.test(t)) || learnedPlaceholders.some((re) => re.test(t));
  }

  function escapeRe(x) {
    return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Remembers this UI language's "X unsent a message" wording (sender name masked). */
  function learnPlaceholder(text, senderName) {
    const t = norm(text);
    if (!t || t.length > 120 || isPlaceholderText(t)) return;
    // Messenger's wording names the sender ("Alpha unsent…", "You unsent…"); anything else is not learned
    const name = norm(senderName);
    const tokens = [name, name.split(' ')[0], ...YOU_LABELS].filter((x) => x && x.length >= 2);
    const lower = t.toLowerCase();
    const hit = tokens.find((x) => lower.includes(x.toLowerCase()));
    if (!hit) return;
    const at = lower.indexOf(hit.toLowerCase());
    const src = '^' + escapeRe(t.slice(0, at)) + '.{1,80}?' + escapeRe(t.slice(at + hit.length)) + '$';
    chrome.storage.local.get('learnedPlaceholders').then(({ learnedPlaceholders: list = [] }) => {
      if (list.includes(src)) return;
      chrome.storage.local.set({ learnedPlaceholders: [...list, src].slice(-20) });
    });
  }

  function loadLearned(list) {
    learnedPlaceholders = (list || [])
      .map((src) => {
        try {
          return new RegExp(src, 'i');
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }
  chrome.storage.local.get('learnedPlaceholders').then(({ learnedPlaceholders: list }) => loadLearned(list));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.learnedPlaceholders) loadLearned(changes.learnedPlaceholders.newValue);
  });

  /** Messenger shows one message under several ids over time ("123", "456@msgr.123"): use the stable part. */
  function canonId(raw) {
    const id = String(raw || '').trim();
    const m = /^(?:\d+@msgr\.)?(\d{16,})$/.exec(id);
    return m ? 'msgr.' + m[1] : id;
  }

  function norm(t) {
    return String(t || '')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Text of an element, with emoji images turned back into their characters. */
  function textOf(root) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (el.classList && (el.classList.contains('mms-recovered') || el.classList.contains('mms-edit-history'))) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        const alt = el.getAttribute('alt') || '';
        if (alt && /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]+$/u.test(alt)) out += alt;
        return;
      }
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') return;
      for (const c of el.childNodes) walk(c);
    };
    walk(root);
    return out.replace(/[\u00a0\u202f]/g, ' ').trim();
  }

  const SKIP_INSIDE = 'h1,h2,h3,h4,h5,h6,[role="toolbar"],[aria-hidden="true"],[role="button"],a[aria-label],[role="link"][aria-label],.mms-recovered,.mms-edit-history';
  const CALL_BUTTONS = '[role="button"][aria-label="Call again"],[role="button"][aria-label="Call back"],[role="button"][aria-label="Join call"],[role="button"][aria-label="Join"]';

  // Delivery status under your own messages ("Sent", "Delivered", "Seen", "Sent 5h ago")
  const STATUS_TEXT = /^(?:sent|delivered|seen|sending\.*|not delivered|failed to send)(?:\s+\d+\s*[smhdw]\w*\s+ago)?$|^seen by\b/i;

  /** The message's own text pieces (not the reply quote, header, toolbar or a11y button). */
  function messageTextNodes(row) {
    const nodes = [];
    for (const el of row.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      if (el.querySelector('div[dir="auto"], span[dir="auto"]')) continue; // use the innermost only
      const skip = el.closest(SKIP_INSIDE);
      if (skip && row.contains(skip)) continue;
      // status line: <span role="presentation"><span dir="auto">Sent</span></span>
      if (el.parentElement && el.parentElement.matches('span[role="presentation"]')) continue;
      if (STATUS_TEXT.test(norm(el.textContent))) continue;
      nodes.push(el);
    }
    return nodes;
  }

  function messageText(row) {
    const parts = [];
    for (const el of messageTextNodes(row)) {
      const t = textOf(el);
      if (t && !parts.includes(t)) parts.push(t);
    }
    // call notices ("Audio call", "Missed video call", "18 mins")
    if (row.querySelector(CALL_BUTTONS)) {
      const bits = [];
      for (const el of row.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
        if (el.querySelector('[dir="auto"]') || el.closest('[role="toolbar"]') || el.closest('[role="button"][aria-label^="Enter,"]')) continue;
        const t = textOf(el);
        if (t && !bits.includes(t)) bits.push(t);
      }
      return bits.length ? '📞 ' + bits.join(' · ') : '📞 Call';
    }
    return parts.join('\n').trim();
  }

  /** Link previews, voice messages and files shown in a row (not photos). */
  function messageExtras(row) {
    const out = [];
    for (const a of row.querySelectorAll('a[aria-label], [role="link"][aria-label]')) {
      const label = norm(a.getAttribute('aria-label'));
      const m = /^open attachment, (.+)$/i.exec(label);
      if (!m) continue;
      const href = a.getAttribute('href') || '';
      out.push({ kind: 'link', title: m[1].slice(0, 300), url: /^https?:/.test(href) ? href : '' });
    }
    if (row.querySelector('[role="slider"][aria-label="Audio scrubber"], audio')) out.push({ kind: 'voice', title: 'Voice message' });
    if (row.querySelector('video')) out.push({ kind: 'video', title: 'Video' });
    return out;
  }

  /** Photos / stickers / GIFs in a row (not avatars, not emoji). */
  function messageImages(row) {
    const out = [];
    for (const img of row.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) continue;
      if (/\/images\/emoji\.php\//.test(src) || /static\.xx\.fbcdn\.net\/images\/emoji/.test(src)) continue;
      const hidden = img.closest('[aria-hidden="true"]');
      if (hidden && row.contains(hidden) && img.closest('[role="button"]')) continue; // avatar
      // the quote of a reply ("Go to replied message") shows the other message's photo
      const labelled = img.closest('[role="button"][aria-label]');
      if (labelled && row.contains(labelled) && !/^open\b/i.test(labelled.getAttribute('aria-label') || '')) continue;
      if (/^original image$/i.test(img.getAttribute('alt') || '')) continue;
      if (/[?&]stp=[^&]*_s(?:\d{1,2}|1[0-4]\d)x/.test(src)) continue; // tiny avatar thumbnails
      const w = Number(img.getAttribute('width')) || img.naturalWidth || 0;
      const h = Number(img.getAttribute('height')) || img.naturalHeight || 0;
      if (w && h && w <= 40 && h <= 40) continue;
      out.push({ src, alt: img.getAttribute('alt') || '', w, h, key: imageKey(src) });
    }
    // stickers are often <div role="img" aria-label="… sticker" style="background-image:url(…)">
    for (const el of row.querySelectorAll('[role="img"][aria-label]')) {
      const m = /url\(["']?([^"')]+)["']?\)/.exec(el.style.backgroundImage || '');
      if (!m) continue;
      out.push({ src: m[1], alt: el.getAttribute('aria-label') || 'sticker', w: el.offsetWidth || 96, h: el.offsetHeight || 96, key: imageKey(m[1]) });
    }
    return out;
  }

  function imageKey(src) {
    if (src.startsWith('blob:') || src.startsWith('data:')) return '';
    try {
      const u = new URL(src);
      return u.pathname.split('/').pop() || '';
    } catch (e) {
      return '';
    }
  }

  function hasEditedMarker(row) {
    for (const b of row.querySelectorAll('[role="button"][aria-label]')) {
      if (EDITED_LABELS.has(norm(b.getAttribute('aria-label')).toLowerCase())) return true;
    }
    for (const el of row.querySelectorAll('span, div')) {
      if (el.children.length) continue;
      const t = norm(el.textContent).toLowerCase();
      if (t && t.length < 25 && EDITED_LABELS.has(t)) {
        if (el.closest('[role="button"][aria-label^="Enter"]')) continue;
        return true;
      }
    }
    return false;
  }

  /* ---------------- sender, time, direction ---------------- */

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  /** Parses English Messenger time labels ("3:11 PM", "Tuesday 10:25pm", "April 16, 2026, 10:55 AM"). */
  function parseTimeLabel(label, now = new Date()) {
    const s = String(label || '').trim().toLowerCase();
    const tm = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(s);
    if (!tm) return 0;
    let hh = Number(tm[1]);
    const mm = Number(tm[2]);
    if (tm[3] === 'pm' && hh < 12) hh += 12;
    if (tm[3] === 'am' && hh === 12) hh = 0;
    const d = new Date(now.getTime());
    d.setSeconds(0, 0);
    const md = /(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:, (\d{4}))?/.exec(s);
    if (md) {
      const mi = MONTHS.findIndex((m) => m.startsWith(md[1].slice(0, 3)));
      d.setFullYear(md[3] ? Number(md[3]) : now.getFullYear(), mi, Number(md[2]));
    } else {
      const wd = WEEKDAYS.findIndex((w) => s.includes(w) || new RegExp('\\b' + w.slice(0, 3) + '\\b').test(s));
      if (wd >= 0) {
        const diff = (now.getDay() - wd + 7) % 7 || 7;
        d.setDate(d.getDate() - diff);
      } else if (s.includes('yesterday')) d.setDate(d.getDate() - 1);
    }
    d.setHours(hh, mm, 0, 0);
    const t = d.getTime();
    return t > now.getTime() + 60000 ? t - 7 * 86400000 : t;
  }

  /**
   * Reads sender and time from the row's aria-label (English):
   *   "At <time>, <Sender>"  |  "At <time>, <Sender>: <text>"  |  "At <time>, <Sender> <text>"
   */
  const TIME_TOKEN = /\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?/i;

  function splitSender(rest, text, avatarName) {
    rest = norm(rest);
    const t = norm(text);
    if (t && rest.endsWith(t) && rest.length > t.length) return rest.slice(0, rest.length - t.length).trim().replace(/:$/, '').trim();
    const colon = rest.indexOf(': ');
    if (colon > 0 && colon < 80) return rest.slice(0, colon).trim();
    if (avatarName && rest.toLowerCase().startsWith(avatarName.toLowerCase())) return avatarName;
    for (const you of YOU_LABELS) if (rest.toLowerCase() === you || rest.toLowerCase().startsWith(you + ' ')) return rest.slice(0, you.length);
    return rest.length <= 60 ? rest : '';
  }

  function parseRowLabel(row, text) {
    const avatar = row.querySelector('[aria-hidden="true"] [role="button"] img[alt]');
    const avatarName = avatar ? norm(avatar.getAttribute('alt')) : '';
    let sender = '';
    let timeLabel = '';
    const label = norm(row.getAttribute('aria-label'));
    let m = /^at (.*?\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?), (.*)$/i.exec(label);
    if (m) {
      timeLabel = m[1];
      sender = splitSender(m[2], text, avatarName);
    }
    if (!sender) {
      // accessibility button next to the message: "Enter, Message sent 12:26 AM by Alpha: text"
      const art = row.closest('[role="article"]');
      const scope = (art && art.parentElement) || row.parentElement;
      const a11y = scope ? scope.querySelector('[role="button"][aria-label^="Enter, Message sent"]') : null;
      const al = a11y ? norm(a11y.getAttribute('aria-label')) : '';
      m = /^enter, message sent (.*?\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?) by (.*)$/i.exec(al);
      if (m) {
        timeLabel = timeLabel || m[1];
        sender = splitSender(m[2], text, avatarName);
      }
    }
    if (!sender) sender = avatarName;
    void TIME_TOKEN;
    return { sender, timeLabel };
  }

  function rowDirection(row, log, sender) {
    const lower = norm(sender).toLowerCase();
    if (YOU_LABELS.has(lower)) return true;
    // (the number before "@msgr" in data-message-id is NOT the sender, so it is not used here)
    if (lower && /^at /i.test(row.getAttribute('aria-label') || '')) return false;
    for (const h of row.querySelectorAll('h1,h2,h4,h5,h6,[role="heading"]')) {
      if (YOU_HEADINGS.test(norm(h.textContent))) return true;
    }
    if (row.querySelector('[aria-hidden="true"] [role="button"][aria-haspopup="dialog"] img, [aria-hidden="true"] [role="button"] img[alt]')) return false; // avatar = someone else
    const lane = row.querySelector(':scope > [role="presentation"]');
    if (lane) {
      const fd = getComputedStyle(lane).flexDirection;
      if (fd === 'row-reverse') return true;
    }
    // Fall back to layout: your own bubbles sit on the right.
    const textEl = messageTextNodes(row)[0] || row.querySelector('img[alt]') || row;
    const r = textEl.getBoundingClientRect();
    const L = log.getBoundingClientRect();
    if (!r.width || !L.width) return null;
    const leftGap = r.left - L.left;
    const rightGap = L.right - r.right;
    if (Math.abs(leftGap - rightGap) < 24) return null;
    return leftGap > rightGap;
  }

  /* ---------------- which chat is this list in? ---------------- */

  function threadFromUrl() {
    const m = /\/(?:messages\/)?(e2ee\/)?t\/([^/?#]+)/.exec(location.pathname);
    if (!m || m[2] === 'new') return null;
    return { id: decodeURIComponent(m[2]), e2ee: !!m[1] };
  }

  function chatWindowOf(log) {
    const zone = log.closest('[data-mw-file-dropzone]');
    return zone ? zone.parentElement || zone : log.parentElement;
  }

  function headingName(el) {
    if (!el) return '';
    const t = norm(textOf(el));
    return t.replace(/^(?:messages in )?conversation (?:with|titled) /i, '').slice(0, 120);
  }

  /** First heading in `scope` that is not inside the message area (that one is a generic "Messages"). */
  function titleOutside(scope, log) {
    if (!scope) return '';
    const zone = log.closest('[data-mw-file-dropzone]');
    for (const h of scope.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      if (log.contains(h) || (zone && zone.contains(h))) continue;
      const name = headingName(h);
      if (name) return name;
    }
    return '';
  }

  function profileIdsIn(scope, log) {
    const ids = [];
    if (!scope) return ids;
    for (const a of scope.querySelectorAll('a[href]')) {
      if (log.contains(a)) continue;
      const href = a.getAttribute('href') || '';
      const pm = /^(?:https:\/\/(?:www|web)\.facebook\.com)?\/(?:profile\.php\?id=)?(\d{5,})\/?(?:[?#].*)?$/.exec(href);
      if (pm) ids.push(pm[1]);
    }
    return [...new Set(ids)];
  }

  function identifyThread(log) {
    const win = chatWindowOf(log);
    let name = '';
    const lm = /^messages in conversation (?:with|titled) (.+)$/i.exec(norm(log.getAttribute('aria-label')));
    if (lm) name = lm[1].slice(0, 120);
    const main = log.closest('[role="main"]');
    const fromUrl = threadFromUrl();
    const isMessagesPage = /^\/(?:messages\/)?(?:e2ee\/)?t\//.test(location.pathname) || location.hostname.endsWith('messenger.com');
    if (main && fromUrl && isMessagesPage) {
      if (!name) {
        const header = main.querySelector('[data-pagelet="MWInboxDetail_MessageList_Header"]');
        name = titleOutside(header, log) || titleOutside(main, log);
      }
      return { id: fromUrl.id, e2ee: fromUrl.e2ee, name, surface: 'page', url: location.href };
    }
    // Chat pop-up: title in its header (outside the message area) and the profile link there.
    if (!name) name = titleOutside(win, log);
    return { id: '', name, altIds: profileIdsIn(win, log), surface: 'popup', url: location.href };
  }

  /* ---------------- reading one message list ---------------- */

  const MSG_SELECTOR = '[data-scope="messages_table"][data-message-id], [data-scope="messages_table"][aria-roledescription="message"]';

  function messageRows(log) {
    const rows = [];
    for (const el of log.querySelectorAll(MSG_SELECTOR)) {
      if (/@msgrCUTOVER/i.test(el.getAttribute('data-message-id') || '')) continue; // "messages are end-to-end encrypted" notice
      if (el.querySelector('[data-scope="date_break"]')) continue;
      const outer = el.parentElement && el.parentElement.closest(MSG_SELECTOR);
      if (outer && log.contains(outer)) continue; // keep the outermost message element
      rows.push(el);
    }
    return rows;
  }

  /** The element that stays in the same place for one message, even if Messenger swaps its id. */
  function rowAnchor(row) {
    return row.closest('[data-pagelet="MWMessageRow"], [role="article"], [role="row"]') || row;
  }

  /** "At 3:11 PM, Alpha" - the part of the label that does not change when a message is unsent. */
  function identityStamp(row, text) {
    let label = norm(row.getAttribute('aria-label'));
    const t = norm(text);
    if (!label) return '';
    if (t && label.endsWith(t)) label = label.slice(0, label.length - t.length).trim().replace(/:$/, '').trim();
    else {
      const colon = label.indexOf(': ');
      if (colon > 0 && /\d[:.]\d{2}/.test(label.slice(0, colon))) {
        const afterTime = label.search(/\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?, /i);
        if (afterTime >= 0 && colon > afterTime) label = label.slice(0, colon);
      }
    }
    return label.slice(0, 160);
  }

  function dateBreakBefore(row, log) {
    // nearest date separator above the row, for the message time
    const all = log.querySelectorAll('[data-scope="date_break"]');
    let best = '';
    for (const d of all) {
      if (d.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) best = norm(d.textContent);
      else break;
    }
    return best;
  }

  const rowCache = new WeakMap(); // row element -> { fp, data }

  /** readRow, but rows whose label, id and content size did not change are not read again. */
  function readRowCached(row, log) {
    const fp = (row.getAttribute('aria-label') || '') + '|' + (row.getAttribute('data-message-id') || '') + '|' + row.textContent.length + '|' + row.getElementsByTagName('img').length + '|' + row.querySelectorAll('[role="img"]').length;
    const hit = rowCache.get(row);
    if (hit && hit.fp === fp) return { ...hit.data };
    const data = readRow(row, log);
    rowCache.set(row, { fp, data: { ...data } });
    return data;
  }

  function readRow(row, log) {
    const domId = canonId(row.getAttribute('data-message-id'));
    let text = messageText(row);
    const label = norm(row.getAttribute('aria-label'));
    // A real "X unsent a message" row has no text in its label ("At 7:54pm, Alpha");
    // a message someone typed with those words does ("At 7:54pm, Bob: Alice deleted a message").
    const placeholder = isPlaceholderText(text) && !(label && label.toLowerCase().includes(norm(text).toLowerCase()));
    const { sender, timeLabel } = parseRowLabel(row, placeholder ? '' : text);
    const isMine = rowDirection(row, log, sender);
    const images = placeholder ? [] : messageImages(row);
    const extras = placeholder ? [] : messageExtras(row);
    if (!placeholder && !text && !images.length && !extras.length) {
      // e.g. the big like: <div role="img" aria-label="Like, thumbs up"><svg/></div>
      const like = row.querySelector('[role="img"][aria-label]');
      if (like && !/url\(/.test(like.style.backgroundImage || '')) text = /thumbs up/i.test(like.getAttribute('aria-label')) ? '👍' : '[' + norm(like.getAttribute('aria-label')).slice(0, 60) + ']';
    }
    const when = timeLabel || dateBreakBefore(row, log);
    return {
      row,
      anchor: rowAnchor(row),
      domId,
      stamp: identityStamp(row, placeholder ? '' : text),
      labelHasBody: !!(text && label && label.includes(norm(text).slice(0, 40))),
      labelLen: label.length,
      text: placeholder ? '' : text,
      placeholderText: placeholder ? text : '',
      placeholder,
      senderName: YOU_LABELS.has(norm(sender).toLowerCase()) ? '' : sender,
      isMine,
      timeLabel: when,
      ts: parseTimeLabel(when),
      ownTs: timeLabel ? parseTimeLabel(timeLabel) : 0, // from this row's own label, not a date separator
      images,
      extras,
      edited: !placeholder && hasEditedMarker(row),
    };
  }

  /* ---------------- per-list state ---------------- */

  const logs = new Map(); // log element -> state
  const rowMemory = new Map(); // message id -> what the row showed this session (live unsend detection)
  const anchorMemory = new WeakMap(); // row element -> the same, survives Messenger changing the id
  const sentSignatures = new Set(); // what was already sent to the background
  /** Copies a decrypted (blob:) photo out of the page. Nothing is cached: the copy goes straight to storage. */
  function blobToDataUrl(src, maxBytes) {
    return fetch(src)
      .then((r) => r.blob())
      .then(
        (b) =>
          new Promise((resolve) => {
            if (!b || b.size > maxBytes || !/^image\//.test(b.type)) return resolve('');
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.onerror = () => resolve('');
            fr.readAsDataURL(b);
          })
      )
      .catch(() => '');
  }

  function memoryFor(r) {
    return (r.domId && rowMemory.get(r.domId)) || anchorMemory.get(r.anchor) || null;
  }

  async function processLog(log, state) {
    state.timer = 0;
    if (!extensionAlive) return;
    if (!document.contains(log)) {
      state.observer.disconnect();
      logs.delete(log);
      return;
    }
    if (!settings.enabled) return;
    const thread = identifyThread(log);
    state.thread = thread;
    const rows = messageRows(log).map((r) => readRowCached(r, log));
    domStats.rows = Math.max(domStats.rows, rows.length);

    // A row that showed a saved message and now shows one short line, with the label's text
    // part gone, has been unsent - this catches Messenger's wording in any language.
    for (const r of rows) {
      if (r.placeholder) continue;
      const before = memoryFor(r);
      if (!before || !before.text || before.unsent || !before.labelHasBody) continue;
      const leaves = messageTextNodes(r.row);
      if (r.text && r.text !== before.text && !r.labelHasBody && r.labelLen && leaves.length === 1 && r.text.length <= 120 && !r.images.length && !r.extras.length) {
        learnPlaceholder(r.text, before.senderName || r.senderName);
        r.placeholderText = r.text;
        r.text = '';
        r.placeholder = true;
      }
    }

    // context: neighbouring texts help find the original of a placeholder later
    const texts = rows.map((r) => r.text);
    const items = [];
    const unsentNow = [];
    const placeholders = [];
    const edited = [];
    const visibleTexts = [];
    const visibleDomIds = [];
    rows.forEach((r, i) => {
      let p = i - 1;
      while (p >= 0 && !texts[p]) p--;
      let n = i + 1;
      while (n < rows.length && !texts[n]) n++;
      r.prev = p >= 0 ? texts[p] : '';
      r.next = n < rows.length ? texts[n] : '';
      if (r.placeholder) {
        domStats.placeholders++;
        const before = memoryFor(r);
        if (before && before.text && !before.unsent) {
          unsentNow.push({ domId: before.domId || r.domId, newDomId: before.domId && before.domId !== r.domId ? r.domId : '', text: before.text, senderName: before.senderName, isMine: before.isMine, prev: r.prev, next: r.next, ts: before.ts, stamp: before.stamp });
          const mark = { ...before, unsent: true };
          if (r.domId) rowMemory.set(r.domId, mark);
          if (before.domId) rowMemory.set(before.domId, mark);
          anchorMemory.set(r.anchor, mark);
        }
        const box = r.row.querySelector('.mms-recovered');
        const tries = box ? Number(box.getAttribute('data-mms-tries') || 0) : 0;
        const checkedAt = box ? Number(box.getAttribute('data-mms-checked') || 0) : 0;
        const retry = box && box.getAttribute('data-mms-state') === 'missing' && tries < 4 && Date.now() - checkedAt > 4000;
        if (!box || retry) {
          placeholders.push({ pid: placeholders.length, domId: r.domId, senderName: r.senderName, isMine: r.isMine, prev: r.prev, next: r.next, stamp: r.stamp, ts: r.ownTs, row: r.row, local: before && before.text ? before : null });
        } else if (box && box.getAttribute('data-mms-state') === 'missing' && tries < 4) state.retryNeeded = true;
        return;
      }
      if (r.text) visibleTexts.push(r.text);
      if (r.domId) visibleDomIds.push(r.domId);
      if (!r.text && !r.images.length && !r.extras.length) return;
      const mem = { domId: r.domId, text: r.text, senderName: r.senderName, isMine: r.isMine, ts: r.ts, media: r.images.length + r.extras.length > 0, stamp: r.stamp, labelHasBody: r.labelHasBody };
      if (r.domId) rowMemory.set(r.domId, mem);
      anchorMemory.set(r.anchor, mem);
      if (r.edited) edited.push(r);
      const sig = [r.domId, r.text, r.images.map((x) => x.key || x.src.slice(0, 80)).join(','), r.extras.map((x) => x.kind + x.title).join(',')].join('|');
      if (!sentSignatures.has(sig)) {
        sentSignatures.add(sig);
        r.sig = sig;
        items.push(r);
      }
    });
    if (sentSignatures.size > 20000) sentSignatures.clear();
    if (rowMemory.size > 20000) rowMemory.clear();

    if (settings.saveMessages && settings.captureDom && (items.length || unsentNow.length)) {
      const maxBytes = Math.min(settings.maxMediaMB || 15, 12) * 1024 * 1024;
      const outItems = [];
      for (const r of items) {
        const images = [];
        for (const im of r.images) {
          if (settings.saveMedia && im.src.startsWith('blob:')) {
            const dataUrl = await blobToDataUrl(im.src, maxBytes);
            if (dataUrl) images.push({ dataUrl, w: im.w, h: im.h, alt: im.alt, key: '' });
          } else if (im.src.startsWith('data:')) {
            if (settings.saveMedia && im.src.length < maxBytes * 1.4) images.push({ dataUrl: im.src, w: im.w, h: im.h, alt: im.alt, key: '' });
          } else images.push({ src: im.src, w: im.w, h: im.h, alt: im.alt, key: im.key });
        }
        outItems.push({ domId: r.domId, text: r.text, senderName: r.senderName, isMine: r.isMine, ts: r.ownTs || r.ts, exactTime: !!r.ownTs, prev: r.prev, next: r.next, stamp: r.stamp, images, extras: r.extras, edited: r.edited });
      }
      domStats.saved += outItems.length;
      // Chrome limits one message to 64 MB: send photos in chunks of about 16 MB.
      const threadInfo = { id: thread.id, name: thread.name, e2ee: !!thread.e2ee, url: thread.url, altIds: thread.altIds || [] };
      const LIMIT = 16 * 1024 * 1024;
      const sizeOf = (it) => (it.text || '').length + it.images.reduce((n, im) => n + (im.dataUrl ? im.dataUrl.length : 300), 0) + 1000;
      // a row with many photos becomes its text first, then one part per photo (same message id)
      const pieces = [];
      outItems.forEach((it, idx) => {
        if (sizeOf(it) <= LIMIT || !it.images.length) return pieces.push({ it, sig: items[idx].sig });
        pieces.push({ it: { ...it, images: [] }, sig: items[idx].sig });
        for (const im of it.images) pieces.push({ it: { ...it, text: '', extras: [], images: [im] }, sig: items[idx].sig });
      });
      const chunks = [];
      let cur = { items: [], sigs: [], size: 0 };
      for (const { it, sig } of pieces) {
        const size = sizeOf(it);
        if (cur.items.length && cur.size + size > LIMIT) {
          chunks.push(cur);
          cur = { items: [], sigs: [], size: 0 };
        }
        cur.items.push(it);
        if (!cur.sigs.includes(sig)) cur.sigs.push(sig);
        cur.size += size;
      }
      if (cur.items.length || unsentNow.length) chunks.push(cur);
      chunks.forEach((chunk, i) => {
        send({
          type: 'ingest-dom',
          batch: { thread: threadInfo, items: chunk.items, unsentNow: i === 0 ? unsentNow : [] },
          ctx: { selfId: selfId() },
        }).then((res) => {
          // not stored (e.g. the background worker was restarting): try again on the next pass
          if (!res || res.error) for (const sig of chunk.sigs) sentSignatures.delete(sig);
        });
      });
    }

    if (settings.showRecoveredInline && placeholders.length) {
      const localOnly = (ph) => ph.local && ph.local.text && !ph.local.media;
      for (const ph of placeholders) {
        if (localOnly(ph)) renderRecovered(ph.row, { text: ph.local.text, media: [], senderName: ph.local.senderName, ts: ph.local.ts, confidence: 'high', live: true });
      }
      const ask = placeholders.filter((ph) => !localOnly(ph));
      if (ask.length) {
        const res = await send({
          type: 'lookup-placeholders',
          thread: { id: thread.id, name: thread.name, altIds: thread.altIds || [] },
          placeholders: ask.map(({ pid, domId, senderName, isMine, prev, next, stamp, ts }) => ({ pid, domId, senderName, isMine, prev, next, stamp, ts })),
          visibleTexts,
          visibleDomIds,
        });
        const found = new Map(((res && res.results) || []).map((x) => [x.pid, x]));
        for (const ph of ask) {
          const hit = found.get(ph.pid);
          if (hit) {
            domStats.recovered++;
            renderRecovered(ph.row, hit);
          } else if (ph.local && ph.local.text) {
            renderRecovered(ph.row, { text: ph.local.text, media: [], senderName: ph.local.senderName, ts: ph.local.ts, confidence: 'high', live: true });
          } else {
            renderNotCaptured(ph.row);
            state.retryNeeded = true;
          }
        }
      }
    }
    if (state.retryNeeded && !state.timer) {
      state.retryNeeded = false;
      state.timer = setTimeout(() => processLog(log, state).catch(() => {}), 4500);
    }

    if (settings.showEditHistoryInline && edited.length) {
      const need = edited.filter((r) => !r.row.querySelector('.mms-edit-history'));
      if (need.length) {
        const res = await send({ type: 'lookup-edited', thread: { id: thread.id, name: thread.name }, items: need.map((r) => ({ text: r.text, domId: r.domId })) });
        const byKey = new Map(((res && res.results) || []).map((x) => [x.domId || norm(x.text), x.history]));
        for (const r of need) {
          const hist = byKey.get(r.domId) || byKey.get(norm(r.text));
          if (hist && hist.length) renderEditHistory(r.row, hist);
        }
      }
    }
  }

  /* ---------------- inline display ---------------- */

  function placeholderAnchor(row) {
    for (const el of messageTextNodes(row)) {
      if (isPlaceholderText(textOf(el))) return el.closest('span[dir="auto"]') || el;
    }
    return null;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return '';
    }
  }

  function makeBox(cls) {
    const box = document.createElement('div');
    box.className = cls;
    box.setAttribute('data-mms', '1');
    return box;
  }

  function insertBox(row, box) {
    const anchor = placeholderAnchor(row);
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(box, anchor.nextSibling);
    else row.appendChild(box);
  }

  function renderRecovered(row, hit) {
    const old = row.querySelector('.mms-recovered');
    if (old && old.getAttribute('data-mms-state') === 'found') return;
    if (old) old.remove();
    const box = makeBox('mms-recovered');
    box.setAttribute('data-mms-state', 'found');
    const head = document.createElement('div');
    head.className = 'mms-head';
    head.textContent = '🛡️ Saved copy of the unsent message' + (hit.confidence === 'medium' ? ' (best match)' : '');
    box.appendChild(head);
    if (hit.text) {
      const body = document.createElement('div');
      body.className = 'mms-text';
      body.textContent = hit.text;
      box.appendChild(body);
    }
    for (const m of hit.media || []) {
      if (m.dataUrl || m.url) {
        const img = document.createElement('img');
        img.className = 'mms-img';
        img.alt = m.title || 'saved photo';
        img.referrerPolicy = 'no-referrer';
        img.src = m.dataUrl || m.url;
        img.addEventListener('error', () => img.remove());
        box.appendChild(img);
      } else if (m.title) {
        const t = document.createElement('div');
        t.className = 'mms-meta';
        t.textContent = '📎 ' + m.title;
        box.appendChild(t);
      }
    }
    const meta = document.createElement('div');
    meta.className = 'mms-meta';
    const when = fmtTime(hit.ts);
    meta.textContent = (when ? (hit.approxTime ? 'saved ' : 'sent ') + when : '') + (hit.unsentAt ? ' · unsent ' + fmtTime(hit.unsentAt) : '');
    if (meta.textContent) box.appendChild(meta);
    box.title = 'Shown by Messenger Message Saver - only you can see this.';
    insertBox(row, box);
  }

  function renderNotCaptured(row) {
    const old = row.querySelector('.mms-recovered');
    if (old && old.getAttribute('data-mms-state') === 'missing') {
      old.setAttribute('data-mms-tries', String(Number(old.getAttribute('data-mms-tries') || 0) + 1));
      old.setAttribute('data-mms-checked', String(Date.now()));
      return;
    }
    if (old) return;
    const box = makeBox('mms-recovered mms-missing');
    box.setAttribute('data-mms-state', 'missing');
    box.setAttribute('data-mms-tries', '1');
    box.setAttribute('data-mms-checked', String(Date.now()));
    box.textContent = '🛡️ No saved copy: this message was unsent before Messenger Message Saver could see it.';
    insertBox(row, box);
  }

  function renderEditHistory(row, history) {
    if (row.querySelector('.mms-edit-history')) return;
    const box = makeBox('mms-edit-history');
    const head = document.createElement('div');
    head.className = 'mms-head';
    head.textContent = '✏️ Before editing:';
    box.appendChild(head);
    for (const h of history.slice(-5)) {
      const line = document.createElement('div');
      line.className = 'mms-text';
      line.textContent = h;
      box.appendChild(line);
    }
    const nodes = messageTextNodes(row);
    const anchor = nodes.length ? nodes[nodes.length - 1].closest('span[dir="auto"]') || nodes[nodes.length - 1] : null;
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(box, anchor.nextSibling);
    else row.appendChild(box);
  }

  function removeInline(selector) {
    document.querySelectorAll(selector).forEach((el) => el.remove());
  }

  /* ---------------- observers ---------------- */

  const NOISE = '[data-mms], [role="toolbar"], [role="timer"], [role="slider"], [role="progressbar"]';

  /** True when every change is ours or inside a playing timer, slider or hover toolbar. */
  function isOwnMutation(records) {
    return records.every((r) => {
      const target = r.target && r.target.nodeType === 1 ? r.target : r.target && r.target.parentElement;
      if (target && target.closest && target.closest(NOISE)) return true;
      const nodes = [...r.addedNodes, ...r.removedNodes];
      if (!nodes.length) return false;
      return nodes.every((n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-mms'));
    });
  }

  function watchLog(log) {
    if (logs.has(log)) return;
    const state = { timer: 0, observer: null, thread: null };
    state.observer = new MutationObserver((records) => {
      if (isOwnMutation(records)) return;
      if (!state.timer) state.timer = setTimeout(() => processLog(log, state).catch(() => {}), 350);
    });
    state.observer.observe(log, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'alt', 'aria-label', 'data-message-id'] });
    cleanups.push(() => {
      state.observer.disconnect();
      clearTimeout(state.timer);
    });
    logs.set(log, state);
    domStats.logs = logs.size;
    state.timer = setTimeout(() => processLog(log, state).catch(() => {}), 200);
  }

  /** Message lists on the page: [role=log] first, then the fallbacks Messenger has used. */
  function findLogs() {
    const found = new Set();
    for (const el of document.querySelectorAll('[role="log"], [data-pagelet="MWMessageList"], [role="grid"][aria-label^="Messages in conversation"]')) {
      if (el.querySelector(MSG_SELECTOR)) found.add(el);
    }
    if (!found.size) {
      // last resort: the lowest element holding all message rows of each chat window
      for (const zone of document.querySelectorAll('[data-mw-file-dropzone]')) if (zone.querySelector(MSG_SELECTOR)) found.add(zone);
    }
    // keep the innermost list when one contains another
    const list = [...found];
    return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
  }

  let scanTimer = 0;
  function scheduleFullScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (!extensionAlive || !settings.enabled) return;
      if (!settings.captureDom && !settings.showRecoveredInline && !settings.showEditHistoryInline) return;
      findLogs().forEach(watchLog);
      for (const [log, state] of logs) {
        if (!document.contains(log)) {
          state.observer.disconnect();
          logs.delete(log);
        } else if (!state.timer) state.timer = setTimeout(() => processLog(log, state).catch(() => {}), 50);
      }
      domStats.logs = logs.size;
    }, 400);
  }

  let started = false;
  function startDom() {
    if (started) return;
    started = true;
    const begin = () => {
      scheduleFullScan();
      const rootObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if ((n.getAttribute && (n.getAttribute('role') === 'log' || n.getAttribute('data-scope') === 'messages_table')) || (n.querySelector && n.querySelector('[role="log"], [data-scope="messages_table"]'))) {
              scheduleFullScan();
              return;
            }
          }
        }
      });
      rootObserver.observe(document.documentElement, { childList: true, subtree: true });
      // Messenger is a single-page app: re-check when the address changes.
      let lastUrl = location.href;
      const urlTimer = setInterval(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          scheduleFullScan();
        }
      }, 1000);
      cleanups.push(() => {
        rootObserver.disconnect();
        clearInterval(urlTimer);
        clearTimeout(scanTimer);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
  }

})();
