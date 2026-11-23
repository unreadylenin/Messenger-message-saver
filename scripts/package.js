// Builds the release files in dist/ from the extension/ folder (no extra tools needed; works on
// Windows, macOS, Linux):
//   MessengerMessageSaver-v<version>-share.zip     to send to anyone: HOW-TO-INSTALL.txt (English +
//                                                  Bangla) and the MessengerMessageSaver/ folder
//   MessageSaverForMessenger-v<version>-webstore.zip  for the Chrome Web Store (manifest at the
//                                                  root; the store name in _locales)
//   SHA256SUMS.txt                                 fingerprints of both
// Run: node scripts/package.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');
const GUIDE = path.join(__dirname, 'share', 'HOW-TO-INSTALL.txt');
const FOLDER = 'MessengerMessageSaver';
const STORE_NAME = 'Message Saver for Messenger'; // a name that does not start with Meta's product name
const SKIP = /^(?:\.|thumbs\.db$|desktop\.ini$)|\.map$/i;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Files under dir (sorted, so the same sources always give the same ZIP). */
function listFiles(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (SKIP.test(name)) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

// fixed timestamp (2026-01-01 00:00) so the same sources give the same zip
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A ZIP file made of [{ name, data }]. */
function zipBuffer(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = centrals.length / 2;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** The install guide as Windows Notepad likes it: UTF-8 with a BOM, CRLF line ends. */
function guideText(version, guidePath = GUIDE) {
  const text = fs.readFileSync(guidePath, 'utf8').replace(/^﻿/, '').replace(/\{\{VERSION\}\}/g, version).replace(/\r?\n/g, '\r\n');
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Checks that would otherwise only show up when a friend installs it, or at Web Store review. */
function check(src) {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];
  if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} differs from package.json ${pkg.version}`);
  if ('key' in manifest) problems.push('manifest has a "key" (it changes installed IDs and the Web Store rejects it)');
  const locales = path.join(src, '_locales');
  if (!fs.existsSync(path.join(locales, manifest.default_locale || 'en', 'messages.json'))) problems.push('default locale messages.json is missing');
  for (const loc of fs.existsSync(locales) ? fs.readdirSync(locales) : []) {
    const msgs = JSON.parse(fs.readFileSync(path.join(locales, loc, 'messages.json'), 'utf8'));
    if (msgs.appDesc && msgs.appDesc.message.length > 132) problems.push(`${loc}: appDesc is longer than the Web Store's 132 characters`);
  }
  if (problems.length) throw new Error('Not packaged:\n - ' + problems.join('\n - '));
  return manifest;
}

function build({ src = SRC, outDir = OUT_DIR, guidePath = GUIDE, log = console.log } = {}) {
  const manifest = check(src);
  const v = manifest.version;
  const files = listFiles(src).map((f) => ({ rel: f.rel, data: fs.readFileSync(f.full) }));

  const share = zipBuffer([{ name: 'HOW-TO-INSTALL.txt', data: guideText(v, guidePath) }, ...files.map((f) => ({ name: `${FOLDER}/${f.rel}`, data: f.data }))]);
  const store = zipBuffer(
    files.map((f) => {
      if (!/^_locales\/[^/]+\/messages\.json$/.test(f.rel)) return { name: f.rel, data: f.data };
      const msgs = JSON.parse(f.data.toString('utf8'));
      if (msgs.appName) msgs.appName.message = STORE_NAME;
      return { name: f.rel, data: Buffer.from(JSON.stringify(msgs, null, 2) + '\n', 'utf8') };
    })
  );

  fs.mkdirSync(outDir, { recursive: true });
  for (const old of fs.readdirSync(outDir)) {
    if (/^(?:messenger-message-saver-v|MessengerMessageSaver-v|MessageSaverForMessenger-v).*\.zip$|^SHA256SUMS\.txt$/.test(old)) fs.unlinkSync(path.join(outDir, old));
  }
  const shareName = `${FOLDER}-v${v}-share.zip`;
  const storeName = `MessageSaverForMessenger-v${v}-webstore.zip`;
  fs.writeFileSync(path.join(outDir, shareName), share);
  fs.writeFileSync(path.join(outDir, storeName), store);
  const sums = `${sha256(share)}  ${shareName}\n${sha256(store)}  ${storeName}\n`;
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums);
  log(`Wrote dist/${shareName} (${files.length + 1} files, ${share.length} bytes)`);
  log(`Wrote dist/${storeName} (${files.length} files, ${store.length} bytes)`);
  log('SHA-256:\n' + sums.trim());
  return { shareName, storeName, share: path.join(outDir, shareName), store: path.join(outDir, storeName), sums };
}

module.exports = { build, zipBuffer, listFiles, guideText, check, STORE_NAME, FOLDER };
if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
