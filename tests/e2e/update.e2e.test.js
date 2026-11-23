'use strict';
// End-to-end: the extension is reloaded (as after an update) and then disabled while a
// Messenger tab stays open. The open tab must follow the new settings, keep saving, and
// go back to Facebook's normal behaviour when the extension is turned off.
//
// Run: node --test tests/e2e/update.e2e.test.js

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
const dec = new TextDecoder();

async function waitFor(fn, { timeout = 15000, interval = 200, what = 'condition' } = {}) {
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

test('open Messenger tab survives an extension update and a disable', { timeout: 180000 }, async (t) => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-upd-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: ['--lang=en-US', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  t.after(async () => {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];

  await ctx.route('https://www.facebook.com/**', (route) =>
    route.request().resourceType() === 'document' ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE }) : route.fulfill({ status: 204, body: '' })
  );
  const gw = { socket: null, fromPage: [] };
  await ctx.routeWebSocket(/^wss:\/\/gateway\.facebook\.com\//, (ws) => {
    gw.socket = ws;
    ws.onMessage((m) => gw.fromPage.push(typeof m === 'string' ? Buffer.from(m) : m));
  });

  const page = await ctx.newPage();
  await page.goto('https://www.facebook.com/');
  await page.evaluate(() => fb.connect());
  await waitFor(() => gw.socket, { what: 'gateway' });
  // the server tells the tab how far this chat is read (as Messenger's sync does)
  gw.socket.send(Buffer.from(h.dgwData(3, h.responseEnvelope([h.call('deleteThenInsertThread', { 0: h.i64(1731571860000), 1: h.i64(1731571000000), 2: 'hi', 3: '', 7: h.i64(THREAD), 9: h.i64(1) }, 50)]))));

  const extPage = async () => {
    const p = await ctx.newPage();
    for (let i = 0; i < 60; i++) {
      try {
        await p.goto(`chrome-extension://${extId}/dashboard/dashboard.html#help`);
        return p;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('extension did not come back');
  };
  const setSettings = (dash, patch) =>
    dash.evaluate(async (p) => {
      const { getSettings } = await import('/lib/settings.js');
      await chrome.storage.local.set({ settings: { ...(await getSettings()), ...p } });
    }, patch);
  const readReceiptLeaving = async (value = 1731571860000) => {
    const before = gw.fromPage.length;
    const readTask = `{"thread_id":${THREAD},"last_read_watermark_ts":${value},"sync_group":1}`;
    await page.evaluate((json) => fb.sendJson(json), h.taskRequest([{ label: '21', payload: readTask, queue: THREAD, taskId: 4 }]));
    const got = await waitFor(() => gw.fromPage.length > before && gw.fromPage[gw.fromPage.length - 1], { what: 'frame' });
    const env = JSON.parse(dec.decode(mw.dgwParse(new Uint8Array(got))[1].payload));
    return JSON.parse(JSON.parse(env.payload).tasks[0].payload).last_read_watermark_ts;
  };

  let dash = await extPage();
  await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000005001', sender: 'Alex Example', time: '3:11 PM', text: 'saved before update' }));
  await waitFor(async () => (await dash.evaluate(async () => (await import('/lib/db.js')).getAll('messages'))).some((m) => m.text === 'saved before update'), { what: 'saved before update' });
  await dash.close();

  await t.test('after a reload (update), settings changes reach the open tab', async () => {
    const ext = await ctx.newPage();
    await ext.goto('chrome://extensions/');
    await ext.locator('#devMode').click();
    await ext.waitForTimeout(400);
    await ext.locator(`extensions-item#${extId} #dev-reload-button`).click();
    await ext.waitForTimeout(2500);
    await ext.close();
    dash = await extPage();

    await setSettings(dash, { blockSeen: false, stealthFocus: false, blockTyping: false });
    await waitFor(async () => (await readReceiptLeaving()) === 1731571860000, { what: 'tab follows "Unseen off" after the update' });
    assert.equal(await readReceiptLeaving(), 1731571860000, '"Seen" goes out untouched when Unseen is off');

    await setSettings(dash, { blockSeen: true, stealthFocus: true, blockTyping: true });
    // Strong mode works on Messenger's own pages only (the news feed keeps real focus)
    await page.evaluate((t) => history.pushState({}, '', '/messages/t/' + t + '/'), THREAD);
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).hasFocus === false, { what: 'tab follows "Unseen on" after the update' });
    // the server now has 1731571860000 (sent while Unseen was off): a newer read is held there, never lower
    assert.equal(await readReceiptLeaving(1731571990000), 1731571860000, '"Seen" held at the server value');
  });

  await t.test('after a reload, the open tab keeps saving and recovering', async () => {
    const dbAll = (s) => dash.evaluate(async (s) => (await import('/lib/db.js')).getAll(s), s);
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000005002', sender: 'Alex Example', time: '3:12 PM', text: 'saved after update' }));
    await waitFor(async () => (await dbAll('messages')).some((m) => m.text === 'saved after update'), { what: 'saved after update' });
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7460000000000005001', 'Alex Example unsent a message'));
    await waitFor(async () => page.evaluate(() => {
      const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000005001"] .mms-recovered');
      return b && b.textContent.includes('saved before update');
    }), { what: 'recovered after update' });
  });

  await t.test('after the extension is turned off, Messenger behaves normally again', async () => {
    await dash.close();
    const ext = await ctx.newPage();
    await ext.goto('chrome://extensions/');
    await ext.locator(`extensions-item#${extId} #enableToggle`).click();
    await ext.waitForTimeout(500);
    await ext.close();
    await waitFor(async () => (await readReceiptLeaving()) === 1731571860000, { timeout: 15000, what: '"Seen" no longer changed once the extension is off' });
    // the tab notices within a few seconds (it checks every 5 s, or at its next message)
    await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('.mms-recovered').length)) === 0, { timeout: 15000, what: 'boxes removed' });
    await page.bringToFront();
    await waitFor(async () => (await page.evaluate(() => fb.focusInfo())).hasFocus === true, { timeout: 15000, what: 'real focus back on the Messenger page' });
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  });
});
