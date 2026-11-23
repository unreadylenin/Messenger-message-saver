'use strict';
// Unit tests for the rules applied to untrusted saved data (extension/lib/sanitize.js).
// Run: node --test tests/unit/sanitize.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../extension/lib/sanitize.js');

test('photo types: only plain image types survive (a crafted type cannot end an HTML attribute)', async () => {
  const { safeImageMime, retypeImageBlob } = await load();
  assert.equal(safeImageMime('image/png'), 'image/png');
  assert.equal(safeImageMime('IMAGE/WEBP'), 'image/webp');
  assert.equal(safeImageMime('image/jpg'), 'image/jpeg');
  assert.equal(safeImageMime('image/png" onerror="alert(1)'), 'image/jpeg');
  assert.equal(safeImageMime('image/svg+xml'), 'image/jpeg', 'SVG can carry script');
  assert.equal(safeImageMime('text/html'), 'image/jpeg');
  assert.equal(safeImageMime(undefined), 'image/jpeg');
  const evil = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png" onerror="x' });
  const fixed = retypeImageBlob(evil);
  assert.equal(fixed.type, 'image/jpeg');
  assert.equal(fixed.size, 3);
  const fine = new Blob([new Uint8Array([1])], { type: 'image/gif' });
  assert.equal(retypeImageBlob(fine), fine, 'a good blob is reused as it is');
});

test('addresses: links https only, pictures only from Facebook / memory / inline photo data', async () => {
  const { httpsUrl, safeLinkHref, safeImgSrc, isFbUrl } = await load();
  assert.equal(httpsUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(httpsUrl('javascript:alert(1)'), '');
  assert.equal(httpsUrl(' JavaScript:alert(1)'), '');
  assert.equal(httpsUrl('data:text/html,<script>1</script>'), '');
  assert.equal(httpsUrl('http://example.com/'), '');
  assert.equal(httpsUrl('file:///C:/Windows/win.ini'), '');
  assert.equal(httpsUrl('not a url'), '');
  assert.equal(httpsUrl({ toString: () => 'https://x.y/' }), '', 'objects are not addresses');
  assert.equal(safeLinkHref('https://l.facebook.com/l.php?u=x'), 'https://l.facebook.com/l.php?u=x');
  assert.equal(safeImgSrc('https://scontent.xx.fbcdn.net/v/a.jpg'), 'https://scontent.xx.fbcdn.net/v/a.jpg');
  assert.equal(safeImgSrc('https://evil.example/track.gif'), '', 'outside servers would learn when you look');
  assert.equal(safeImgSrc('https://fbcdn.net.evil.example/a.jpg'), '');
  assert.equal(safeImgSrc('blob:chrome-extension://abc/123'), 'blob:chrome-extension://abc/123');
  assert.equal(safeImgSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(safeImgSrc('data:image/svg+xml;base64,AAAA'), '');
  assert.equal(safeImgSrc('javascript:alert(1)'), '');
  assert.equal(isFbUrl('https://video.xx.fbcdn.net/v/a.mp4'), true);
  assert.equal(isFbUrl('https://cdn.fbsbx.com/v/t59/a.jpg'), true);
  assert.equal(isFbUrl('http://video.xx.fbcdn.net/a.mp4'), false);
});

test('size caps: one message cannot fill the disk', async () => {
  const { capMessage, LIMITS } = await load();
  const big = 'x'.repeat(LIMITS.text + 5000);
  const m = capMessage({ text: big, replyText: big, senderName: 'n'.repeat(2000), history: Array.from({ length: 80 }, (_, i) => ({ text: 'v' + i + big, at: i })), attachments: Array.from({ length: 100 }, () => ({})) });
  assert.equal(m.text.length, LIMITS.text);
  assert.equal(m.replyText.length, LIMITS.text);
  assert.equal(m.senderName.length, LIMITS.name);
  assert.equal(m.history.length, LIMITS.history);
  assert.equal(m.history[m.history.length - 1].text.length, LIMITS.text, 'the newest versions are kept');
  assert.equal(m.history[m.history.length - 1].at, 79);
  assert.equal(m.attachments.length, LIMITS.attachments);
  const odd = capMessage({ text: { evil: true }, history: 'nope', attachments: 5 });
  assert.equal(odd.text, '');
  assert.deepEqual(odd.history, []);
  assert.deepEqual(odd.attachments, []);
});

test('restore: records are rebuilt from known fields; hostile values are dropped or neutralised', async () => {
  const s = await load();
  assert.equal(s.cleanImportedMessage({ text: 'no key' }), null);
  assert.equal(s.cleanImportedMessage({ key: 42 }), null);
  const m = s.cleanImportedMessage({
    key: 'fb:mid.$1',
    text: { not: 'text' },
    threadKey: '123',
    unsent: 'yes',
    ts: 'soon',
    isMine: 'true',
    history: [{ text: 'old', at: 5 }, { text: 7 }, null, 'x'],
    attachments: [{ previewUrl: 'javascript:alert(1)', actionUrl: 'https://ok.example/', title: 'Doc', mediaKey: 'fbid:1' }, 'junk'],
    reactions: JSON.parse('{"__proto__": "x", "100": "👍"}'),
    extraField: 'dropped',
  });
  assert.equal(m.key, 'fb:mid.$1');
  assert.equal(m.text, '');
  assert.equal(m.unsent, true);
  assert.equal(m.ts, undefined, 'a non-number time is not kept');
  assert.equal(m.isMine, undefined, 'only real booleans');
  assert.deepEqual(m.history, [{ text: 'old', at: 5 }]);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].previewUrl, '');
  assert.equal(m.attachments[0].actionUrl, 'https://ok.example/');
  assert.equal(m.attachments[0].mediaKey, 'fbid:1');
  assert.equal(m.extraField, undefined);
  assert.deepEqual(Object.keys(m.reactions), ['100']);
  assert.equal(Object.getPrototypeOf(m.reactions), Object.prototype, 'prototype untouched');

  assert.deepEqual(s.cleanImportedMedia({ key: 'fbid:1', mime: 'image/png"><script>', data: 'AAAA', url: 'javascript:1' }), { key: 'fbid:1', mime: 'image/jpeg', url: '', messageKey: '', savedAt: 0, size: 0, data: 'AAAA' });
  assert.equal(s.cleanImportedMedia({ key: 'k', data: 5 }), null);
  const t = s.cleanImportedThread({ threadKey: 't1', name: 'Chat', pic: 'http://evil.example/p.png', url: 'javascript:1', aliasFor: 't2', pageIds: ['1', 2, '3'] });
  assert.deepEqual(t, { threadKey: 't1', name: 'Chat', aliasFor: 't2', pageIds: ['1', '3'] });
  assert.equal(s.cleanImportedContact({ id: '9', name: 'A', pic: 'https://scontent.xx.fbcdn.net/p.jpg' }).pic, 'https://scontent.xx.fbcdn.net/p.jpg');
  assert.equal(s.cleanImportedEvent({ type: 'hacked' }), null);
  assert.equal(s.cleanImportedNotification({ title: '', body: '' }), null);
  assert.equal(s.cleanImportedAlias({ domId: 'a' }), null);
});

test('diagnostics: only known counters are kept (the report comes from the page)', async () => {
  const { cleanDiag } = await load();
  const d = cleanDiag({ messages: 3, junk: 'x'.repeat(1e6), lastError: 'e'.repeat(1000), sockets: { dgw: 1, evil: 'x' }, dom: { logs: 2, more: [1, 2] }, strongMode: 1 });
  assert.equal(d.messages, 3);
  assert.equal(d.junk, undefined);
  assert.equal(d.lastError.length, 200);
  assert.deepEqual(d.sockets, { dgw: 1, mqtt: 0, e2ee: 0, other: 0 });
  assert.deepEqual(d.dom, { logs: 2, rows: 0, saved: 0, placeholders: 0, recovered: 0 });
  assert.equal(d.strongMode, true);
  assert.ok(JSON.stringify(d).length < 1000);
});
