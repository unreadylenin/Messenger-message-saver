'use strict';
// End-to-end test: loads the real extension into Chromium, serves a test double of the
// Messenger page on https://www.facebook.com/ and a fake gateway WebSocket, then checks
// saving, unsend recovery, edits, photos, Unseen and the dashboard.
//
// Run: node --test tests/e2e/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const h = require('../unit/helpers.js');
const mw = require('../../extension/content/main-world.js');

const EXT = path.resolve(__dirname, '../../extension');
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../fixtures/mock-messenger.html'), 'utf8');
const THREAD = '100012345678901';
const ME = '100099999999999';
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const dec = new TextDecoder();

async function waitFor(fn, { timeout = 10000, interval = 150, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''));
}

test('Messenger Message Saver end to end', { timeout: 240000 }, async (t) => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  t.after(async () => {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];

  // fake facebook.com
  await ctx.route('https://www.facebook.com/**', (route) => {
    if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE });
    return route.fulfill({ status: 204, body: '' });
  });
  await ctx.grantPermissions(['notifications'], { origin: 'https://www.facebook.com' });

  // fake gateway.facebook.com
  const gw = { socket: null, fromPage: [] };
  await ctx.routeWebSocket(/^wss:\/\/gateway\.facebook\.com\//, (ws) => {
    gw.socket = ws;
    ws.onMessage((msg) => gw.fromPage.push(typeof msg === 'string' ? Buffer.from(msg) : msg));
  });

  // extension page used to read the extension's own database
  const dash = await ctx.newPage();
  dash.on('pageerror', (e) => errors.push('dashboard: ' + e.message));
  await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#unsent`);
  const dbAll = (store) => dash.evaluate(async (s) => (await import('/lib/db.js')).getAll(s), store);
  const setSettings = (patch) =>
    dash.evaluate(async (p) => {
      const { getSettings } = await import('/lib/settings.js');
      const cur = await getSettings();
      await chrome.storage.local.set({ settings: { ...cur, ...p } });
    }, patch);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  await page.goto('https://www.facebook.com/');
  await page.context().addCookies([{ name: 'c_user', value: ME, domain: '.facebook.com', path: '/', secure: true }]);

  await t.test('page hook is installed before the page runs', async () => {
    assert.equal(await page.evaluate(() => window.__mmsInstalled === true), true);
    assert.equal(await page.evaluate(() => typeof window.fb), 'object');
  });

  await t.test('Unseen strong mode makes the page look backgrounded, and can be switched off', async () => {
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).visibilityState === 'hidden', { what: 'hidden' });
    const info = await page.evaluate(() => fb.focusInfo());
    assert.deepEqual(info, { hasFocus: false, visibilityState: 'hidden', hidden: true });
    await setSettings({ stealthFocus: false });
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).visibilityState === 'visible', { what: 'visible again' });
    await setSettings({ stealthFocus: true });
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).hidden === true, { what: 'hidden again' });
  });

  await t.test('network: message saved, then kept after the sender unsends it', async () => {
    await page.evaluate(() => fb.connect());
    await waitFor(() => gw.socket, { what: 'gateway connection' });
    const steps = [
      h.call('verifyContactRowExists', { 0: h.i64(THREAD), 2: '', 3: 'Khondoker Aurthe' }, 22),
      h.call('deleteThenInsertThread', { 0: h.i64(1731571860000), 1: h.i64(1731571000000), 2: 'hi', 3: '', 7: h.i64(THREAD), 9: h.i64(1) }, 50),
      h.insertMessage({ text: 'network secret', threadKey: THREAD, ts: 1731571860000, id: 'mid.$net1', senderId: THREAD }),
    ];
    gw.socket.send(Buffer.from(h.dgwData(3, h.responseEnvelope(steps))));
    const saved = await waitFor(async () => (await dbAll('messages')).find((m) => m.key === 'fb:mid.$net1'), { what: 'network message saved' });
    assert.equal(saved.text, 'network secret');
    assert.equal(saved.isMine, false);

    gw.socket.send(Buffer.from(h.dgwData(3, h.responseEnvelope([h.insertMessage({ text: '', threadKey: THREAD, ts: 1731571860000, id: 'mid.$net1', senderId: THREAD, unsent: true, proc: 'deleteThenInsertMessage' })]))));
    const after = await waitFor(async () => (await dbAll('messages')).find((m) => m.key === 'fb:mid.$net1' && m.unsent), { what: 'unsent flag' });
    assert.equal(after.text, 'network secret', 'original text kept');
    const contacts = await dbAll('contacts');
    assert.ok(contacts.some((c) => c.id === THREAD && c.name === 'Khondoker Aurthe'));
    const notes = await sw.evaluate(() => new Promise((r) => chrome.notifications.getAll(r)));
    assert.ok(Object.keys(notes).some((k) => k.startsWith('mms|')), 'desktop alert shown for the unsend');
  });

  await t.test('Unseen: "Seen" is rewound and "typing" is cleared before leaving the browser', async () => {
    const sendTask = `{"thread_id":${THREAD},"otid":"7123456789012345678","source":65537,"send_type":1,"sync_group":1,"text":"hi","initiating_source":1}`;
    const readTask = `{"thread_id":${THREAD},"last_read_watermark_ts":1731571860000,"sync_group":1}`;
    const req = h.taskRequest([
      { label: '46', payload: sendTask, queue: THREAD, taskId: 3 },
      { label: '21', payload: readTask, queue: THREAD, taskId: 4 },
    ]);
    const before = gw.fromPage.length;
    await page.evaluate((json) => fb.sendJson(json), req);
    const got = await waitFor(() => gw.fromPage.length > before && gw.fromPage[gw.fromPage.length - 1], { what: 'frame at server' });
    const frames = mw.dgwParse(new Uint8Array(got));
    assert.equal(frames.length, 2);
    const env = JSON.parse(dec.decode(frames[1].payload));
    const inner = JSON.parse(env.payload);
    assert.equal(inner.tasks.length, 2, 'no task dropped');
    assert.equal(JSON.parse(inner.tasks[0].payload).text, 'hi', 'message send untouched');
    assert.equal(JSON.parse(inner.tasks[1].payload).last_read_watermark_ts, 1731571000000, 'read marker rewound to what the server already had');
    assert.ok(dec.decode(frames[1].payload).includes('7300123456789012345'), '64-bit ids unchanged');

    const before2 = gw.fromPage.length;
    await page.evaluate((json) => fb.sendJson(json, false), h.typingRequest({ threadKey: THREAD, typing: 1 }));
    const got2 = await waitFor(() => gw.fromPage.length > before2 && gw.fromPage[gw.fromPage.length - 1], { what: 'typing frame' });
    const env2 = JSON.parse(dec.decode(mw.dgwParse(new Uint8Array(got2))[1].payload));
    assert.equal(JSON.parse(JSON.parse(env2.payload).payload).is_typing, 0);

    await setSettings({ blockSeen: false, blockTyping: false });
    await new Promise((r) => setTimeout(r, 400));
    const before3 = gw.fromPage.length;
    await page.evaluate((json) => fb.sendJson(json), req);
    const got3 = await waitFor(() => gw.fromPage.length > before3 && gw.fromPage[gw.fromPage.length - 1], { what: 'frame with unseen off' });
    const inner3 = JSON.parse(JSON.parse(dec.decode(mw.dgwParse(new Uint8Array(got3))[1].payload)).payload);
    assert.equal(JSON.parse(inner3.tasks[1].payload).last_read_watermark_ts, 1731571860000, 'untouched when Unseen is off');
    await setSettings({ blockSeen: true, blockTyping: true });
  });

  await t.test('screen: incoming and own messages are saved with sender and direction', async () => {
    await page.evaluate(() => {
      fb.dateBreak('Today');
      fb.addMessage({ domId: '100012345678901@msgr.7001', sender: 'Khondoker Aurthe', time: '3:11 PM', text: 'screen secret' });
      fb.addMessage({ domId: '100099999999999@msgr.7002', sender: 'You', time: '3:12 PM', text: 'Good afternoon', mine: true });
    });
    const rec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100012345678901@msgr.7001'), { what: 'screen message saved' });
    assert.equal(rec.text, 'screen secret');
    assert.equal(rec.senderName, 'Khondoker Aurthe');
    assert.equal(rec.isMine, false);
    assert.ok(rec.ts > 0);
    const mine = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100099999999999@msgr.7002'), { what: 'own message saved' });
    assert.equal(mine.isMine, true);
    // Messenger puts the same number before "@msgr" on everyone's messages: it must not decide direction
    await page.evaluate(() => fb.addMessage({ domId: '100099999999999@msgr.7005', sender: 'Khondoker Aurthe', time: '3:13 PM', text: 'same prefix, still incoming' }));
    const incoming = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100099999999999@msgr.7005'), { what: 'prefixed incoming saved' });
    assert.equal(incoming.isMine, false);
    assert.equal(incoming.senderName, 'Khondoker Aurthe');
  });

  await t.test('screen: live unsend shows the original under "unsent a message"', async () => {
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7001', 'Khondoker Aurthe unsent a message'));
    const box = await waitFor(async () => {
      const txt = await page.evaluate(() => {
        const b = document.querySelector('[data-message-id="100012345678901@msgr.7001"] .mms-recovered');
        return b && b.textContent;
      });
      return txt && txt.includes('screen secret') ? txt : null;
    }, { what: 'recovered box' });
    assert.match(box, /Saved copy/);
    const rec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100012345678901@msgr.7001' && m.unsent), { what: 'unsent flag in db' });
    assert.equal(rec.text, 'screen secret');
  });

  await t.test('screen: edits keep the earlier text and show it in the chat', async () => {
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7003', sender: 'Khondoker Aurthe', time: '3:14 PM', text: 'original words' }));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100012345678901@msgr.7003'), { what: 'message before edit' });
    await page.evaluate(() => fb.edit('100012345678901@msgr.7003', 'changed words'));
    const rec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100012345678901@msgr.7003' && m.edited), { what: 'edit saved' });
    assert.equal(rec.text, 'changed words');
    assert.equal(rec.history[0].text, 'original words');
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7003"] .mms-edit-history');
      return b && b.textContent.includes('original words');
    }), { what: 'edit history box' });
  });

  await t.test('screen: photos are saved and shown again after an unsend', async () => {
    await page.evaluate((png) => fb.addMessage({ domId: '100012345678901@msgr.7004', sender: 'Khondoker Aurthe', time: '3:15 PM', text: '', photo: 'data:image/png;base64,' + png }), PNG_1x1);
    const rec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === '100012345678901@msgr.7004' && m.attachments.some((a) => a.mediaKey)), { what: 'photo stored' });
    assert.ok(rec.attachments.length >= 1);
    const media = await dbAll('media');
    assert.ok(media.some((x) => x.key === rec.attachments[0].mediaKey && x.size > 0));
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7004', 'Khondoker Aurthe unsent a message'));
    await waitFor(async () => page.evaluate(() => !!document.querySelector('[data-message-id="100012345678901@msgr.7004"] .mms-recovered img')), { what: 'recovered photo' });
  });

  await t.test('encrypted chats: unsent row gets a NEW id - still matched, live and after reload', async () => {
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000008001', sender: 'Khondoker Aurthe', time: '3:16 PM', text: 'id will change' }));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000008001'), { what: 'saved under canonical id' });
    await page.evaluate(() => fb.unsendInPlace('100012345678901@msgr.7460000000000008001', '100012345678901@msgr.7460000000000009999', 'Khondoker Aurthe deleted a message'));
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000009999"] .mms-recovered');
      return b && b.textContent.includes('id will change');
    }), { what: 'live recovery despite id change' });
    const alias = await waitFor(async () => (await dbAll('aliases')).find((a) => a.domId === 'msgr.7460000000000009999'), { what: 'alias stored' });
    assert.ok(alias.messageKey);
    const rec = (await dbAll('messages')).find((m) => m.key === alias.messageKey);
    assert.equal(rec.unsent, true);
    assert.equal(rec.text, 'id will change');
  });

  await t.test('stickers, blob photos and the "Edited" button are understood', async () => {
    await page.evaluate((png) => {
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000008101', sender: 'Khondoker Aurthe', time: '3:17 PM', text: '', photo: fb.blobPng(png) });
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000008102', sender: 'Khondoker Aurthe', time: '3:17 PM', text: '', sticker: 'data:image/png;base64,' + png });
    }, PNG_1x1);
    const blobRec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000008101' && m.attachments.some((a) => a.mediaKey)), { what: 'blob photo stored' });
    assert.ok(blobRec);
    const stickerRec = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000008102' && m.attachments.length), { what: 'sticker saved' });
    assert.ok(stickerRec.attachments[0]);
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000008103', sender: 'Khondoker Aurthe', time: '3:18 PM', text: 'before button edit' }));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000008103'), { what: 'pre-edit saved' });
    await page.evaluate(() => fb.edit('100012345678901@msgr.7460000000000008103', 'after button edit', true));
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000008103"] .mms-edit-history');
      return b && b.textContent.includes('before button edit');
    }), { what: 'edit history via Edited button' });
  });

  await t.test('other UI languages: the unsent wording is learned from the page', async () => {
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000008201', sender: 'Khondoker Aurthe', time: '3:19 PM', text: 'learn me' }));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000008201'), { what: 'saved before unsend' });
    // a wording no built-in pattern knows
    await page.evaluate(() => fb.unsendInPlace('100012345678901@msgr.7460000000000008201', '100012345678901@msgr.7460000000000008201', 'Khondoker Aurthe zz-unsendword-zz'));
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000008201"] .mms-recovered');
      return b && b.textContent.includes('learn me');
    }), { what: 'structural unsend detection' });
    const learned = await dash.evaluate(async () => (await chrome.storage.local.get('learnedPlaceholders')).learnedPlaceholders || []);
    assert.ok(learned.some((src) => src.includes('zz-unsendword-zz')), 'pattern learned: ' + JSON.stringify(learned));
  });

  await t.test('after a reload, old placeholders are filled from the saved copy', async () => {
    await page.evaluate(() =>
      fb.addMessage({ domId: '100012345678901@msgr.7101', sender: 'Khondoker Aurthe', time: '3:20 PM', text: 'alpha one' }) ||
      fb.addMessage({ domId: '100012345678901@msgr.7102', sender: 'Khondoker Aurthe', time: '3:20 PM', text: 'beta two' }) ||
      fb.addMessage({ domId: '100012345678901@msgr.7103', sender: 'Khondoker Aurthe', time: '3:21 PM', text: 'gamma three' })
    );
    await waitFor(async () => (await dbAll('messages')).some((m) => m.text === 'gamma three'), { what: 'context rows saved' });
    await page.reload();
    await page.evaluate(() => {
      fb.addMessage({ domId: '100012345678901@msgr.7001', sender: 'Khondoker Aurthe', time: '3:11 PM', placeholder: 'Khondoker Aurthe unsent a message' });
      fb.addMessage({ domId: '100012345678901@msgr.7101', sender: 'Khondoker Aurthe', time: '3:20 PM', text: 'alpha one' });
      // same position, but Messenger gave the placeholder a different id: matched by its neighbours
      fb.addMessage({ domId: '100012345678901@msgr.9999', sender: 'Khondoker Aurthe', time: '3:20 PM', placeholder: 'Khondoker Aurthe unsent a message' });
      fb.addMessage({ domId: '100012345678901@msgr.7103', sender: 'Khondoker Aurthe', time: '3:21 PM', text: 'gamma three' });
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000009999', sender: 'Khondoker Aurthe', time: '3:16 PM', placeholder: 'Khondoker Aurthe deleted a message' });
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000008201', sender: 'Khondoker Aurthe', time: '3:19 PM', placeholder: 'Khondoker Aurthe zz-unsendword-zz' });
    });
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000009999"] .mms-recovered');
      return b && b.textContent.includes('id will change');
    }), { what: 'recovery through the stored id alias' });
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000008201"] .mms-recovered');
      return b && b.textContent.includes('learn me');
    }), { what: 'learned wording recognised after reload' });
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7001"] .mms-recovered');
      return b && b.textContent.includes('screen secret');
    }), { what: 'exact match by message id' });
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.9999"] .mms-recovered');
      return b && b.textContent.includes('beta two');
    }), { what: 'match by neighbouring messages' });
  });

  await t.test('Messenger notifications are kept as a backup copy', async () => {
    await page.evaluate(() => {
      try {
        new Notification('Khondoker Aurthe', { body: 'notification text' });
      } catch (e) {
        /* permission */
      }
    });
    const n = await waitFor(async () => (await dbAll('notifications')).find((x) => x.body === 'notification text'), { what: 'notification saved' });
    assert.equal(n.title, 'Khondoker Aurthe');
  });

  await t.test('dashboard lists recovered messages; popup shows counts', async () => {
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#unsent`);
    await waitFor(async () => {
      const text = await dash.textContent('#unsent-list');
      return text.includes('network secret') && text.includes('screen secret');
    }, { what: 'dashboard cards' });
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#thread=${THREAD}`);
    await waitFor(async () => (await dash.textContent('#thread-messages')).includes('network secret'), { what: 'chat view' });
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#settings`);
    await waitFor(async () => (await dash.textContent('#diag')).includes('gateway'), { what: 'diagnostics table' });

    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await waitFor(async () => Number(await popup.textContent('#s-unsent')) >= 3, { what: 'popup unsent count' });
    await waitFor(async () => (await popup.textContent('#recent-list')).includes('screen secret'), { what: 'popup recent list' });
    await popup.close();
  });

  await t.test('no script errors anywhere', async () => {
    assert.deepEqual(errors, []);
  });
});
