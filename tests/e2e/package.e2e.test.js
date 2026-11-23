'use strict';
// End-to-end: builds the release ZIPs, checks what is inside, unzips them and loads each one as
// a real extension in Chromium (as a friend would with "Load unpacked").
//
// Run: node --test tests/e2e/package.e2e.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { chromium } = require('playwright');
const pkg = require('../../scripts/package.js');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'extension');

/** Reads a ZIP file into [{ name, data }] (stored and deflated entries). */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end of central directory found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26);
    const lExtra = buf.readUInt16LE(local + 28);
    const body = buf.slice(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(zlib.crc32 ? zlib.crc32(data) >>> 0 : crc, crc, `CRC of ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function extract(entries, dir) {
  for (const e of entries) {
    const target = path.join(dir, e.name);
    assert.ok(target.startsWith(dir + path.sep), 'no entry escapes the folder');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
  }
}

async function loadAndCheck(extDir) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-pkg-profile-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: ['--lang=en-US', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const extId = sw.url().split('/')[2];
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${extId}/dashboard/dashboard.html#help`);
    await page.waitForFunction(() => document.querySelector('#view-help li b'));
    const info = await page.evaluate(() => ({ version: chrome.runtime.getManifest().version, name: chrome.i18n.getMessage('appName'), desc: chrome.i18n.getMessage('appDesc'), help: document.querySelector('#view-help').innerText.length }));
    return { ...info, errors };
  } finally {
    await ctx.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

test('release ZIPs: contents, guide, fingerprints, and each one installs', { timeout: 180000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-pkg-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // a copy of the sources with the junk Windows and editors leave behind
  const src = path.join(work, 'src');
  fs.cpSync(SRC, src, { recursive: true });
  fs.writeFileSync(path.join(src, 'Thumbs.db'), 'junk');
  fs.writeFileSync(path.join(src, 'icons', 'desktop.ini'), 'junk');
  fs.writeFileSync(path.join(src, 'content', 'content.js.map'), '{}');
  const out = path.join(work, 'dist');
  const res = pkg.build({ src, outDir: out, log: () => {} });
  const version = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version;
  const expected = pkg.listFiles(SRC).map((f) => f.rel);

  await t.test('share ZIP: the guide plus one MessengerMessageSaver folder, nothing else', () => {
    const entries = unzip(fs.readFileSync(res.share));
    const names = entries.map((e) => e.name);
    assert.equal(names[0], 'HOW-TO-INSTALL.txt');
    assert.deepEqual(names.slice(1), expected.map((n) => 'MessengerMessageSaver/' + n));
    assert.ok(names.every((n) => /^[\x20-\x7e]+$/.test(n)), 'plain file names (old Windows unzip)');
    assert.ok(!names.some((n) => /thumbs\.db|desktop\.ini|\.map$|tests\/|fixtures/i.test(n)), 'no junk or test files');
    for (const e of entries.slice(1)) assert.ok(e.data.equals(fs.readFileSync(path.join(SRC, e.name.slice('MessengerMessageSaver/'.length)))), `${e.name} identical to the source`);
    const guide = entries[0].data;
    assert.deepEqual([...guide.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with a BOM for Notepad');
    const text = guide.slice(3).toString('utf8');
    assert.ok(!/[^\r]\n/.test(text), 'Windows line ends only');
    assert.ok(text.includes(`MESSENGER MESSAGE SAVER ${version}`) && !text.includes('{{VERSION}}'));
    assert.ok(text.includes('বাংলা: কীভাবে ইনস্টল করবেন'), 'Bangla part present');
    assert.ok(text.includes('%USERPROFILE%') && text.includes('Load unpacked') && text.includes('Get-FileHash'));
  });

  await t.test('web store ZIP: manifest at the root, the store name, no "key"', () => {
    const entries = unzip(fs.readFileSync(res.store));
    assert.deepEqual(entries.map((e) => e.name), expected);
    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data);
    assert.ok(!('key' in manifest));
    for (const loc of ['en', 'bn']) {
      const msgs = JSON.parse(entries.find((e) => e.name === `_locales/${loc}/messages.json`).data);
      assert.equal(msgs.appName.message, pkg.STORE_NAME);
      assert.ok(msgs.appDesc.message.length <= 132);
    }
  });

  await t.test('SHA256SUMS.txt matches both files', () => {
    const lines = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const [hash, name] = line.split(/\s+/);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex'), hash);
    }
  });

  await t.test('a bad build is refused (version mismatch)', () => {
    const bad = path.join(work, 'bad');
    fs.cpSync(SRC, bad, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8'));
    m.version = '0.0.1';
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify(m));
    assert.throws(() => pkg.build({ src: bad, outDir: path.join(work, 'bad-out'), log: () => {} }), /version/);
  });

  await t.test('unzipped share folder loads in Chromium (as "Load unpacked" does)', async () => {
    const dir = path.join(work, 'friend');
    extract(unzip(fs.readFileSync(res.share)), dir);
    const info = await loadAndCheck(path.join(dir, 'MessengerMessageSaver'));
    assert.equal(info.version, version);
    assert.equal(info.name, 'Messenger Message Saver');
    assert.ok(info.desc.length > 20);
    assert.ok(info.help > 500, 'help text rendered');
    assert.deepEqual(info.errors, []);
  });

  await t.test('unzipped web store package loads with the store name', async () => {
    const dir = path.join(work, 'store');
    extract(unzip(fs.readFileSync(res.store)), dir);
    const info = await loadAndCheck(dir);
    assert.equal(info.name, pkg.STORE_NAME);
    assert.deepEqual(info.errors, []);
  });
});
