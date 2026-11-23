'use strict';
// End-to-end: the Bangla interface (Saved Messages, popup, buttons and boxes inside Facebook)
// and the optional PIN lock (nothing saved is shown before the right PIN).
//
// Run: node --test tests/e2e/privacy-language.e2e.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const I18N = require('../../extension/lib/i18n.js');

const EXT = path.resolve(__dirname, '../../extension');
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../fixtures/mock-messenger.html'), 'utf8');
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const bn = (key, vars) => I18N.translate('bn', key, vars);
const en = (key, vars) => I18N.translate('en', key, vars);
const SECRET = 'demo secret text 4821';

async function waitFor(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
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

test('Bangla interface and PIN lock', { timeout: 360000 }, async (t) => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-pl-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: ['--lang=en-US', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  t.after(async () => {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];
  const worker = () => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`)) || sw;
  const url = (p) => `chrome-extension://${extId}/${p}`;

  await ctx.route('https://www.facebook.com/**', (route) =>
    route.request().resourceType() === 'document' ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE }) : route.fulfill({ status: 204, body: '' })
  );
  await ctx.route(/^https:\/\/[^/]*fbcdn\.net\//, (route) =>
    route.request().resourceType() === 'image' ? route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_1x1, 'base64') }) : route.fulfill({ status: 404, body: '' })
  );

  const dash = await ctx.newPage();
  dash.on('pageerror', (e) => errors.push('dashboard: ' + e.message));
  await dash.goto(url('dashboard/dashboard.html#unsent'));
  const setSettings = (patch) =>
    dash.evaluate(async (p) => {
      const { getSettings } = await import('/lib/settings.js');
      await chrome.storage.local.set({ settings: { ...(await getSettings()), ...p } });
    }, patch);
  // demo data, fictional
  await dash.evaluate(async (secret) => {
    const db = await import('/lib/db.js');
    await db.withStores(['messages', 'threads'], 'readwrite', async (s) => {
      s.threads.put({ threadKey: 'demo-thread-1', domName: 'Demo Friend' });
      for (let i = 0; i < 12; i++) {
        s.messages.put(db.finalizeMessage({ key: 'dm:demo' + i, threadKey: 'demo-thread-1', senderName: 'Demo Friend', text: i === 0 ? secret : 'demo message ' + i, ts: Date.now() - i * 60000, capturedAt: Date.now(), unsent: i === 0, unsentAt: Date.now(), history: [], attachments: [], sources: ['screen'] }));
      }
    });
  }, SECRET);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  await page.goto('https://www.facebook.com/');

  await t.test('Bangla: Saved Messages, popup and what is shown inside Facebook', async () => {
    await setSettings({ uiLanguage: 'bn' });
    await dash.reload();
    await waitFor(async () => (await dash.textContent('.tabs [data-view="chats"]')).trim() === bn('tab.chats'), { what: 'Bangla tabs' });
    assert.equal(await dash.getAttribute('html', 'lang'), 'bn');
    assert.equal((await dash.textContent('.tabs [data-view="unsent"] [data-i18n]')).trim(), bn('tab.unsent'));
    assert.equal(await dash.title(), bn('page.title'));
    await waitFor(async () => /১২টি মেসেজ সেভ/.test(await dash.textContent('#totals-line')), { what: 'Bengali digits in the totals' });
    await dash.goto(url('dashboard/dashboard.html#settings'));
    assert.equal((await dash.textContent('#privacy-panel h3')).trim(), bn('privacy.title'));
    assert.equal(await dash.inputValue('select[data-setting="uiLanguage"]'), 'bn');
    await dash.goto(url('dashboard/dashboard.html#help'));
    assert.ok((await dash.textContent('#view-help')).includes('কীভাবে কাজ করে'));
    assert.equal(await dash.locator('#view-help li b').count() > 3, true, 'bold words built as elements');

    const popup = await ctx.newPage();
    popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(url('popup/popup.html'));
    await waitFor(async () => (await popup.textContent('#open-dashboard')).trim() === bn('popup.open'), { what: 'Bangla popup' });
    assert.ok((await popup.textContent('#state-line')).includes(bn('state.saving')));
    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= 362), 'popup fits its 360 px width');

    // inside Facebook: the download button and the "unsent" box
    await page.bringToFront();
    await page.evaluate(() => fb.addFeedVideo({ id: '5555555555', hd: 'https://video-x.xx.fbcdn.net/v/t42/bn.mp4?x=1' }));
    await page.mouse.move(5, 5);
    await page.hover('[role="article"] .player-overlay');
    const btn = page.locator('[data-mms="download"] .btn');
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal((await btn.textContent()).trim(), bn('dl.video'));
    await page.evaluate(() => fb.clearMain());
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000009101', sender: 'Alex Example', time: '5:01 PM', text: 'বাংলা টেস্ট' }));
    await waitFor(async () => (await dash.evaluate(async () => (await import('/lib/db.js')).getAll('messages'))).some((m) => m.text === 'বাংলা টেস্ট'), { what: 'saved before unsend' });
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7460000000000009101', 'Alex Example unsent a message'));
    await waitFor(
      async () => page.evaluate((head) => {
        const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000009101"] .mms-recovered .mms-head');
        return b && b.textContent.startsWith(head);
      }, bn('box.saved')),
      { what: 'Bangla box in the chat' }
    );

    // back to English from the popup: the open Saved Messages page follows at once
    await dash.goto(url('dashboard/dashboard.html#unsent'));
    await popup.bringToFront();
    await popup.click('.lang-switch [data-lang="en"]');
    await waitFor(async () => (await dash.textContent('.tabs [data-view="chats"]')).trim() === en('tab.chats'), { what: 'dashboard back in English' });
    assert.equal(await dash.getAttribute('html', 'lang'), 'en');
    await waitFor(async () => (await popup.textContent('#open-dashboard')).trim() === en('popup.open'), { what: 'popup back in English' });
    await waitFor(
      async () => page.evaluate((head) => {
        const b = document.querySelector('[data-message-id="100012345678901@msgr.7460000000000009101"] .mms-recovered .mms-head');
        return b && b.textContent.startsWith(head);
      }, en('box.saved')),
      { what: 'box redrawn in English' }
    );
    await popup.close();
  });

  await t.test('PIN lock: nothing saved is shown before the right PIN', async () => {
    // record desktop alerts
    await worker().evaluate(() => {
      self.__notes = [];
      const orig = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = (id, opts) => {
        self.__notes.push(opts);
        return orig(id, opts);
      };
    });
    await dash.bringToFront();
    await dash.goto(url('dashboard/dashboard.html#settings'));
    await dash.fill('#pin-new', '2468');
    await dash.fill('#pin-repeat', '1357');
    await dash.click('#pin-set');
    await waitFor(async () => (await dash.textContent('#toast')) === en('privacy.mismatch'), { what: 'mismatch refused' });
    await dash.fill('#pin-repeat', '2468');
    await dash.click('#pin-set');
    await waitFor(async () => (await dash.textContent('#toast')) === en('privacy.setDone'), { what: 'PIN set' });
    assert.equal(await dash.isVisible('#pin-on'), true);
    assert.ok(!JSON.stringify(await dash.evaluate(() => chrome.storage.local.get(null))).includes('2468'), 'the PIN is not stored');

    // Lock now: only the PIN screen, no saved data anywhere in the page
    await dash.click('#lock-now');
    await dash.waitForSelector('#lock-screen:not([hidden])');
    assert.equal(await dash.isVisible('header.bar'), false);
    assert.equal((await dash.textContent('#totals-line')).trim(), '', 'no counts while locked');
    assert.ok(!(await dash.evaluate(() => document.body.innerText)).includes(SECRET));
    // a deep link to a chat shows the lock too
    await dash.goto(url('dashboard/dashboard.html#thread=demo-thread-1'));
    await dash.reload();
    await dash.waitForSelector('#lock-screen:not([hidden])');
    assert.ok(!(await dash.evaluate(() => document.body.innerText)).includes(SECRET));

    // the popup hides the list and counts; the in-chat copies can be switched off, not on
    const popup = await ctx.newPage();
    await popup.goto(url('popup/popup.html'));
    await popup.waitForSelector('#recent-locked:not([hidden])');
    assert.equal((await popup.textContent('#s-messages')).trim(), '–');
    assert.ok(!(await popup.evaluate(() => document.body.innerText)).includes(SECRET));
    const inline = popup.locator('input[data-setting="showRecoveredInline"]');
    assert.equal(await inline.isChecked(), true);
    await popup.locator('label.row', { has: inline }).click();
    await waitFor(async () => (await inline.isDisabled()) && !(await inline.isChecked()), { what: 'inline switch off and locked' });
    await popup.close();

    // wrong PIN five times: a wait, and even the right PIN is refused meanwhile
    for (let i = 0; i < 5; i++) {
      await dash.fill('#lock-pin', '0000');
      await dash.click('#lock-submit');
      await waitFor(async () => !(await dash.isDisabled('#lock-submit')) || (await dash.isDisabled('#lock-pin')), { what: 'try ' + i });
    }
    await waitFor(async () => (await dash.textContent('#lock-error')).includes(en('lock.wait', { s: '' }).split('{s}')[0].slice(0, 20)), { what: 'wait message' });
    assert.equal(await dash.isDisabled('#lock-pin'), true);
    await worker().evaluate(() => chrome.storage.session.set({ pinFails: { n: 0, until: 0 } }));
    await dash.reload();
    await dash.waitForSelector('#lock-screen:not([hidden])');
    await dash.fill('#lock-pin', '2468');
    await dash.click('#lock-submit');
    await waitFor(async () => (await dash.textContent('#thread-title')).includes('Demo Friend'), { what: 'unlocked into the deep-linked chat' });
    assert.ok((await dash.evaluate(() => document.body.innerText)).includes(SECRET));

    // the session expires: the page locks itself again
    await worker().evaluate(() => chrome.storage.session.set({ unlockedUntil: Date.now() - 1000 }));
    await dash.waitForSelector('#lock-screen:not([hidden])', { timeout: 20000 });
    assert.ok(!(await dash.evaluate(() => document.body.innerText)).includes(SECRET));

    // while the lock is on, an unsend alert names the person but not the text
    await page.bringToFront();
    await page.evaluate(() => fb.addMessage({ domId: '100012345678901@msgr.7460000000000009102', sender: 'Alex Example', time: '5:02 PM', text: 'alert secret 9917' }));
    // read the database from an extension page that is not the (locked) Saved Messages page
    const probe = await ctx.newPage();
    await probe.goto(url('popup/popup.html'));
    await waitFor(async () => (await probe.evaluate(async () => (await import('/lib/db.js')).getAll('messages'))).some((m) => m.text === 'alert secret 9917'), { what: 'saved' });
    await probe.close();
    await page.bringToFront();
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7460000000000009102', 'Alex Example unsent a message'));
    const note = await waitFor(async () => (await worker().evaluate(() => self.__notes || [])).find((n) => /unsent a message/.test(n.title)), { what: 'unsend alert' });
    assert.equal(note.message, en('notify.lockedBody'));
    assert.ok(!JSON.stringify(note).includes('alert secret 9917'));

    // forgot the PIN: everything saved is deleted, then the lock is gone
    await dash.bringToFront();
    await dash.click('#lock-forgot');
    await dash.waitForSelector('#confirm-dialog[open]');
    await dash.click('#confirm-ok');
    const left = await waitFor(
      async () => {
        const r = await dash.evaluate(async () => ({ lock: (await chrome.storage.local.get('lock')).lock, messages: (await (await import('/lib/db.js')).getAll('messages')).length, screen: !document.querySelector('#lock-screen').hidden }));
        return r.lock === undefined && !r.screen ? r : null;
      },
      { what: 'data wiped and lock removed' }
    );
    assert.equal(left.messages, 0);
  });

  await t.test('no script errors anywhere', async () => {
    assert.deepEqual(errors, []);
  });
});
