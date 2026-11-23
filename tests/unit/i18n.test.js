'use strict';
// Checks the English / Bangla interface text (extension/lib/i18n.js) and that every text key
// the extension uses exists. Run: node --test tests/unit/i18n.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I18N = require('../../extension/lib/i18n.js');

const EXT = path.resolve(__dirname, '../../extension');
const read = (p) => fs.readFileSync(path.join(EXT, p), 'utf8');
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[1].toLowerCase());

test('every entry has English and Bangla, with the same {placeholders} and only <b>/<i>', () => {
  const S = I18N.STRINGS;
  const keys = Object.keys(S);
  assert.ok(keys.length > 250, 'about 300 entries');
  for (const k of keys) {
    const [en, bn] = S[k];
    assert.ok(typeof en === 'string' && en.length, `${k}: English missing`);
    assert.ok(typeof bn === 'string' && bn.length, `${k}: Bangla missing`);
    assert.deepEqual(placeholders(bn), placeholders(en), `${k}: placeholders differ`);
    for (const tag of [...tags(en), ...tags(bn)]) assert.ok(tag === 'b' || tag === 'i', `${k}: tag <${tag}> not allowed`);
    assert.deepEqual(tags(bn).sort(), tags(en).sort(), `${k}: tags differ`);
    if (!/^(?:set\.unseen|set\.language|lang\.)/.test(k) && en.length > 12 && !/Messenger Message Saver|^[⬇🔒]/.test(en)) {
      assert.notEqual(bn, en, `${k}: Bangla is a copy of the English`);
    }
  }
});

test('translate(): language, numbers in Bengali digits, fall-backs', () => {
  assert.equal(I18N.translate('en', 'thread.saved', { n: 12 }), '12 saved');
  assert.equal(I18N.translate('bn', 'thread.saved', { n: 12 }), '১২টি সেভ');
  assert.equal(I18N.translate('bn', 'search.results', { q: 'hello 42' }), '“hello 42”-এর ফলাফল', 'text values keep their own digits');
  assert.equal(I18N.translate('en', 'no.such.key'), 'no.such.key');
  assert.equal(I18N.translate('xx', 'tab.chats'), 'Chats', 'unknown language falls back to English');
  assert.equal(I18N.translate('en', 'chatN', {}), 'Chat {key}', 'missing values stay visible');
  assert.equal(I18N.num(2026, 'bn'), '২০২৬');
  assert.equal(I18N.locale('bn'), 'bn-BD');
  assert.equal(I18N.locale('en'), undefined);
});

test('resolve(): automatic follows the browser language only for Bangla', () => {
  assert.equal(I18N.resolve('bn', 'en-US'), 'bn');
  assert.equal(I18N.resolve('en', 'bn'), 'en');
  assert.equal(I18N.resolve('auto', 'bn'), 'bn');
  assert.equal(I18N.resolve('auto', 'bn-BD'), 'bn');
  assert.equal(I18N.resolve('auto', 'en-GB'), 'en');
  assert.equal(I18N.resolve(undefined, 'fr'), 'en');
  assert.equal(I18N.resolve('auto', 'bs'), 'en', 'Bosnian is not Bangla');
});

test('every key used in the HTML pages and scripts exists', () => {
  const missing = [];
  const need = (k, where) => {
    if (!I18N.has(k)) missing.push(`${k} (${where})`);
  };
  for (const page of ['dashboard/dashboard.html', 'popup/popup.html']) {
    const html = read(page);
    for (const m of html.matchAll(/data-i18n(?:-rich|-title|-placeholder|-aria-label)?="([^"]+)"/g)) need(m[1], page);
  }
  const scripts = {
    'dashboard/dashboard.js': /\bt\('([^']+)'/g,
    'popup/popup.js': /\bt\('([^']+)'/g,
    'lib/format.js': /\bt\('([^']+)'/g,
    'content/content.js': /\btr\('([^']+)'/g,
    'background/service-worker.js': /\bL\('([^']+)'/g,
  };
  for (const [file, re] of Object.entries(scripts)) {
    const src = read(file);
    let count = 0;
    for (const m of src.matchAll(re)) {
      need(m[1], file);
      count++;
    }
    assert.ok(count > 0, `${file} uses translated text`);
    // keys picked with a condition: t(x ? 'a' : 'b')
    for (const m of src.matchAll(/\b(?:t|tr|L)\([^()]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      need(m[1], file);
      need(m[2], file);
    }
  }
  assert.deepEqual(missing, []);
});

test('manifest text comes from _locales in both languages; the store summary fits 132 characters', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  const en = JSON.parse(read('_locales/en/messages.json'));
  const bn = JSON.parse(read('_locales/bn/messages.json'));
  assert.deepEqual(Object.keys(bn).sort(), Object.keys(en).sort());
  const used = JSON.stringify(manifest).match(/__MSG_(\w+)__/g).map((m) => m.slice(6, -2));
  for (const k of used) assert.ok(en[k] && bn[k], `__MSG_${k}__ defined in both locales`);
  for (const [loc, msgs] of [['en', en], ['bn', bn]]) assert.ok(msgs.appDesc.message.length <= 132, `${loc} appDesc too long for the Web Store`);
  assert.ok(!('key' in manifest), 'no "key": it would change installed IDs and the Web Store rejects it');
});

test('the interface text loads before the content script, everywhere it is injected', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const isolated = manifest.content_scripts.find((c) => c.js.includes('content/content.js'));
  assert.deepEqual(isolated.js, ['lib/i18n.js', 'content/content.js']);
  assert.match(read('background/service-worker.js'), /files: \['lib\/i18n\.js', 'content\/content\.js'\]/);
});

test('the content script keeps the same default settings as lib/settings.js', () => {
  const lib = read('lib/settings.js');
  const content = read('content/content.js');
  const keysOf = (src, anchor) => {
    const start = src.indexOf(anchor);
    const body = src.slice(start, src.indexOf('}', start));
    return [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  };
  assert.deepEqual(keysOf(content, 'const DEFAULT_SETTINGS = {'), keysOf(lib, 'export const DEFAULT_SETTINGS = Object.freeze({'));
});

test('rich text is built from <b>/<i> only (no HTML parsing)', () => {
  const made = [];
  const node = (tag) => ({
    tagName: tag.toUpperCase(),
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    set textContent(v) {
      this.children = [];
    },
  });
  const doc = {
    createElement: (tag) => {
      made.push(tag);
      return node(tag);
    },
    createTextNode: (text) => ({ text }),
  };
  const el = node('li');
  el.ownerDocument = doc;
  I18N.rich(el, 'A <b>bold</b> <img src=x onerror=alert(1)> and <i>it &amp; that</i>');
  assert.deepEqual(made, ['b', 'i'], 'only b and i elements are created');
  const flat = (n) => (n.text !== undefined ? n.text : n.children.map(flat).join(''));
  assert.equal(flat(el), 'A bold <img src=x onerror=alert(1)> and it & that', 'anything else stays plain text');
});
