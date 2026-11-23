// Makes the Chrome Web Store images in store/ from fictional demo data (no real people):
//   store/screenshots/1-unsent.jpg … 5-bangla.jpg   1280x800
//   store/promo-small-440x280.jpg                    440x280
// Run: node scripts/store-assets.js   (needs Playwright with Chromium)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const demoData = require('../tests/fixtures/demo-data.js');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'store');
const SHOTS = path.join(OUT, 'screenshots');
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tests/fixtures/mock-messenger.html'), 'utf8');
const ICON = 'data:image/png;base64,' + fs.readFileSync(path.join(EXT, 'icons/icon128.png')).toString('base64');
// a stand-in picture for "photos" on the demo Facebook page
const DEMO_PHOTO = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#c16bff"/></linearGradient></defs><rect width="600" height="400" fill="url(#g)"/><circle cx="470" cy="110" r="55" fill="#ffd166"/><path d="M0 330 L170 200 L300 300 L410 230 L600 360 L600 400 L0 400Z" fill="#2b2d42" opacity=".55"/><text x="30" y="370" font-family="Segoe UI, sans-serif" font-size="28" fill="#fff">Demo photo</text></svg>`;

/** Width and height of a JPEG (from its SOF marker). */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-store-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    args: ['--lang=en-US', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const written = [];
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = sw.url().split('/')[2];
    const url = (p) => `chrome-extension://${extId}/${p}`;
    await ctx.route('https://www.facebook.com/**', (route) =>
      route.request().resourceType() === 'document' ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE }) : route.fulfill({ status: 204, body: '' })
    );
    await ctx.route(/^https:\/\/[^/]*fbcdn\.net\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: DEMO_PHOTO }));

    const dash = await ctx.newPage();
    await dash.goto(url('dashboard/dashboard.html#help'));
    const setSettings = (patch) =>
      dash.evaluate(async (p) => {
        const { getSettings } = await import('/lib/settings.js');
        await chrome.storage.local.set({ settings: { ...(await getSettings()), ...p } });
      }, patch);
    await setSettings({ uiLanguage: 'en' });
    await dash.evaluate((data) => import('/lib/db.js').then((db) => db.importAll(data)), demoData());

    const shoot = async (page, name) => {
      const file = path.join(SHOTS, name);
      await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
      written.push(file);
    };

    // 1. unsent messages kept
    await dash.goto(url('dashboard/dashboard.html#unsent'));
    await dash.waitForSelector('#unsent-list .card');
    await dash.waitForTimeout(300);
    await shoot(dash, '1-unsent.jpg');

    // 2. a chat with an edited and an unsent message
    await dash.goto(url('dashboard/dashboard.html#thread=demo-group'));
    await dash.reload();
    await dash.waitForSelector('#thread-messages .bubble');
    await dash.waitForTimeout(300);
    await shoot(dash, '2-chat.jpg');

    // 3. inside Facebook: the saved original under "unsent a message", and the download button
    const page = await ctx.newPage();
    await page.goto('https://www.facebook.com/');
    await page.evaluate(() => {
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000006001', sender: 'Alex Example', time: '3:10 PM', text: 'Are we still on for tonight?' });
      fb.addMessage({ domId: '100012345678901@msgr.7460000000000006002', sender: 'Alex Example', time: '3:11 PM', text: 'Actually I can’t come, something came up' });
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => fb.unsend('100012345678901@msgr.7460000000000006002', 'Alex Example unsent a message'));
    await page.waitForSelector('.mms-recovered');
    await page.evaluate(() => fb.addPhoto({ src: 'https://scontent.xx.fbcdn.net/v/t39.30808-6/demo_photo_n.jpg?stp=dst-jpg_s600x400&oh=1' }));
    // dress the plain test page up as a feed + chat window, with captions (screenshot only)
    await page.addStyleTag({
      content: `
        body { background: #f0f2f5; font-family: 'Segoe UI', system-ui, sans-serif; }
        main.page { padding: 36px 0 0 40px; margin-right: 400px; }
        main.page [role="article"] { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.15); padding: 14px; width: 600px; }
        main.page [role="article"]::before { content: 'Demo post · 2 h'; display: block; font-weight: 600; color: #65676b; margin-bottom: 10px; }
        main.page img { width: 600px !important; height: 400px !important; border-radius: 8px; margin: 0 !important; }
        .popup { background: #fff; border: 0 !important; border-radius: 12px 12px 0 0; box-shadow: 0 6px 24px rgba(0,0,0,.25); right: 30px !important; width: 340px !important; height: 560px !important; }
        .popup-head { font-size: 15px; }
        .popup-head h2 { font-size: 16px; margin: 0; }
        .popup-head a { color: #1c1e21; text-decoration: none; }
        [data-mw-file-dropzone] > h2 { display: none; }
        [role="button"][aria-label^="Enter, Message sent"] { display: none; }
        [role="textbox"] { margin: 8px; padding: 8px 12px; border-radius: 18px; background: #f0f2f5; color: #65676b; }
        .caption { position: fixed; left: 40px; bottom: 40px; width: 600px; color: #1c1e21; }
        .caption h1 { font-size: 30px; margin: 0 0 8px; }
        .caption p { font-size: 18px; margin: 0; color: #444; }`,
    });
    await page.evaluate(() => {
      const c = document.createElement('div');
      c.className = 'caption';
      c.innerHTML = '<h1>Unsent? Still readable.</h1><p>The saved original appears right under “unsent a message”. Point at any photo, video or reel to download it.</p>';
      document.body.appendChild(c);
    });
    await page.mouse.move(5, 5);
    await page.hover('#page-main img');
    await page.locator('[data-mms="download"] .btn').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shoot(page, '3-in-facebook.jpg');

    // 4. the toolbar popup, placed on a plain background
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(url('popup/popup.html'));
    await popup.waitForTimeout(800);
    const popupPng = (await popup.screenshot({ type: 'png' })).toString('base64');
    await popup.close();
    const frame = await ctx.newPage();
    await frame.setViewportSize({ width: 1280, height: 800 });
    await frame.setContent(
      `<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:70px;background:linear-gradient(135deg,#e8f0ff,#f6e8ff);font-family:'Segoe UI',system-ui,sans-serif">` +
        `<img src="data:image/png;base64,${popupPng}" style="width:360px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25)">` +
        `<div style="max-width:520px;color:#1c1e21"><img src="${ICON}" width="72" height="72"><h1 style="font-size:40px;margin:18px 0 12px">Everything in one click</h1>` +
        `<p style="font-size:22px;line-height:1.45;color:#444">Unseen mode, hide “typing…”, download buttons, alerts and recently unsent messages — right from the toolbar. In English or বাংলা.</p></div></body></html>`
    );
    await frame.waitForTimeout(300);
    await shoot(frame, '4-popup.jpg');
    await frame.close();

    // 5. the Bangla interface
    await setSettings({ uiLanguage: 'bn' });
    await dash.goto(url('dashboard/dashboard.html#unsent'));
    await dash.reload();
    await dash.waitForSelector('#unsent-list .card');
    await dash.waitForTimeout(300);
    await shoot(dash, '5-bangla.jpg');
    await setSettings({ uiLanguage: 'en' });

    // small promo tile
    const tile = await ctx.newPage();
    await tile.setViewportSize({ width: 440, height: 280 });
    await tile.setContent(
      `<!doctype html><html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:22px;padding:0 30px;box-sizing:border-box;background:linear-gradient(135deg,#0866ff,#a033ff);color:#fff;font-family:'Segoe UI',system-ui,sans-serif">` +
        `<img src="${ICON}" width="96" height="96" style="filter:drop-shadow(0 4px 10px rgba(0,0,0,.3))"><div><div style="font-size:26px;font-weight:700;line-height:1.15">Message Saver<br>for Messenger</div>` +
        `<div style="font-size:15px;margin-top:10px;opacity:.95">Unsent messages stay readable</div></div></body></html>`
    );
    const tileFile = path.join(OUT, 'promo-small-440x280.jpg');
    await tile.screenshot({ path: tileFile, type: 'jpeg', quality: 90 });
    written.push(tileFile);
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }

  let bad = 0;
  for (const file of written) {
    const size = jpegSize(fs.readFileSync(file));
    const want = file.endsWith('440x280.jpg') ? { width: 440, height: 280 } : { width: 1280, height: 800 };
    const ok = size && size.width === want.width && size.height === want.height;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${path.relative(ROOT, file)} ${size ? size.width + 'x' + size.height : '?'}`);
  }
  if (bad) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
