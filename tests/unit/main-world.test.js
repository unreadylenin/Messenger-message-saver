'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mw = require('../../extension/content/main-world.js');
const h = require('./helpers.js');

const dec = new TextDecoder();
const THREAD = '100012345678901';
const ME = '100099999999999';

test('DGW: parses establish + data + ack frames', () => {
  const buf = h.concat(h.dgwEstablish(4), h.dgwData(4, '{"a":1}', { ackId: 9 }), h.dgwAck(4, 9));
  const frames = mw.dgwParse(buf);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, 15);
  assert.equal(frames[1].type, 13);
  assert.equal(frames[1].streamId, 4);
  assert.equal(frames[1].ackId, 9);
  assert.equal(frames[1].requiresAck, true);
  assert.equal(dec.decode(frames[1].payload), '{"a":1}');
  assert.equal(frames[2].type, 12);
});

test('DGW: rejects non-DGW bytes', () => {
  assert.equal(mw.dgwParse(Uint8Array.from([0x82, 1, 2])), null);
  assert.equal(mw.dgwParse(Uint8Array.from([13, 1, 0, 50, 0, 0, 1, 0])), null); // truncated
});

test('LightSpeed: incoming message, unsend, edit, photo, contact, thread', () => {
  const steps = [
    h.call('verifyContactRowExists', { 0: h.i64(THREAD), 2: 'https://scontent.xx.fbcdn.net/p.jpg', 3: 'Alex Example' }, 22),
    h.call('deleteThenInsertThread', { 0: h.i64(1731571860000), 1: h.i64(1731571000000), 2: 'hello', 3: '', 7: h.i64(THREAD), 9: h.i64(1) }, 50),
    h.insertMessage({ text: 'Good afternoon', threadKey: THREAD, ts: 1731571860000, id: 'mid.$abc1', senderId: THREAD }),
    h.call(
      'insertBlobAttachment',
      {
        0: 'image-1.jpg',
        8: 'https://scontent.xx.fbcdn.net/v/t1.15752-9/photo.jpg?oe=1',
        11: 'image/jpeg',
        14: h.i64(720),
        15: h.i64(960),
        27: h.i64(THREAD),
        29: h.i64(2),
        30: 'image/jpeg',
        31: h.i64(1731571860001),
        32: 'mid.$abc2',
        34: h.i64(1234567),
      },
      49
    ),
    h.call('editMessage', { 0: 'mid.$abc1', 1: h.i64(80), 2: 'Good evening', 3: h.i64(1) }, 4),
    h.call('updateOrInsertEditMessageHistory', { 0: 'mid.$abc1', 1: h.i64(THREAD), 2: h.i64(1731571870000), 3: 'Good afternoon', 4: h.i64(1) }, 5),
    h.insertMessage({ text: '', threadKey: THREAD, ts: 1731571860000, id: 'mid.$abc1', senderId: THREAD, unsent: true, proc: 'deleteThenInsertMessage' }),
    h.call('markThreadReadV2', { 0: h.i64(THREAD), 1: h.i64(1731571800000) }, 2),
  ];
  const buf = h.dgwData(1, h.responseEnvelope(steps));
  const ev = mw.eventsFromIncomingBytes(buf, 'dgw');

  assert.equal(ev.contacts.length, 1);
  assert.equal(ev.contacts[0].name, 'Alex Example');
  assert.equal(ev.threads[0].threadKey, THREAD);
  assert.equal(ev.threads[0].readWatermark, 1731571000000);

  assert.equal(ev.messages.length, 1);
  assert.deepEqual(
    { id: ev.messages[0].id, text: ev.messages[0].text, threadKey: ev.messages[0].threadKey, senderId: ev.messages[0].senderId, ts: ev.messages[0].ts },
    { id: 'mid.$abc1', text: 'Good afternoon', threadKey: THREAD, senderId: THREAD, ts: 1731571860000 }
  );

  assert.equal(ev.attachments.length, 1);
  assert.equal(ev.attachments[0].messageId, 'mid.$abc2');
  assert.equal(ev.attachments[0].type, 2);
  assert.match(ev.attachments[0].previewUrl, /photo\.jpg/);

  assert.deepEqual(ev.edits[0], { id: 'mid.$abc1', text: 'Good evening', editCount: 1 });
  assert.equal(ev.editHistory[0].text, 'Good afternoon');

  assert.equal(ev.unsent.length, 1);
  assert.equal(ev.unsent[0].id, 'mid.$abc1');
  assert.equal(ev.unsent[0].threadKey, THREAD);

  assert.deepEqual(ev.readWatermarks[0], { threadKey: THREAD, ts: 1731571800000 });
});

test('LightSpeed: STORE/LOAD/IF are followed; unknown conditions walk both branches', () => {
  const program = [
    1,
    [3, 0, h.i64(1)],
    [23, [2, 0], h.insertMessage({ text: 'yes', threadKey: THREAD, ts: 1, id: 'mid.$y', senderId: THREAD }), h.insertMessage({ text: 'no', threadKey: THREAD, ts: 1, id: 'mid.$n', senderId: THREAD })],
    [23, [5, 'checkSomething', h.i64(1)], h.insertMessage({ text: 'both-a', threadKey: THREAD, ts: 2, id: 'mid.$a', senderId: THREAD }), h.insertMessage({ text: 'both-b', threadKey: THREAD, ts: 3, id: 'mid.$b', senderId: THREAD })],
  ];
  const ev = mw.extractEvents(mw.lsCollectCalls(program));
  assert.deepEqual(
    ev.messages.map((m) => m.text),
    ['yes', 'both-a', 'both-b']
  );
});

test('LightSpeed: finds programs in GraphQL text with for(;;) prefix and NDJSON', () => {
  const steps = [h.insertMessage({ text: 'from http', threadKey: THREAD, ts: 5, id: 'mid.$h', senderId: THREAD })];
  const doc1 = JSON.stringify({ data: { viewer: { lightspeed_web_request: { payload: h.lsPayload(steps), dependencies: [] } } } });
  const text = 'for (;;);' + doc1 + '\n' + JSON.stringify({ label: 'x', data: {} });
  const ev = mw.eventsFromText(text);
  assert.equal(ev.messages.length, 1);
  assert.equal(ev.messages[0].text, 'from http');
});

test('LightSpeed: MQTT /ls_resp payloads are read too', () => {
  const steps = [h.insertMessage({ text: 'via mqtt', threadKey: THREAD, ts: 6, id: 'mid.$m', senderId: ME })];
  const buf = h.mqttPublish('/ls_resp', h.responseEnvelope(steps));
  const ev = mw.eventsFromIncomingBytes(buf, 'mqtt');
  assert.equal(ev.messages[0].text, 'via mqtt');
});

test('Unseen: mark-read task is rewound, other tasks and big ids untouched (DGW)', () => {
  const sendPayload = `{"thread_id":${THREAD},"otid":"7123456789012345678","source":65537,"send_type":1,"sync_group":1,"text":"hi","initiating_source":1,"skip_url_preview_gen":0}`;
  const readPayload = `{"thread_id":${THREAD},"last_read_watermark_ts":1731571860000,"sync_group":1}`;
  const req = h.taskRequest([
    { label: '46', payload: sendPayload, queue: THREAD, taskId: 3 },
    { label: '21', payload: readPayload, queue: THREAD, taskId: 4 },
  ]);
  const original = h.concat(h.dgwEstablish(6), h.dgwData(6, req, { ackId: 2 }));
  const watermarks = new Map([[THREAD, 1731571000000]]);
  const res = mw.rewriteOutgoingBytes(original, 'dgw', { blockSeen: true, blockTyping: true, readWatermarks: watermarks });
  assert.ok(res, 'should rewrite');
  assert.deepEqual(res.actions, [{ type: 'seen-blocked', thread: THREAD, label: '21', from: '1731571860000', to: 1731571000000 }]);

  const frames = mw.dgwParse(res.bytes);
  assert.equal(frames.length, 2);
  assert.deepEqual(Array.from(frames[0].raw), Array.from(original.subarray(0, frames[0].raw.length)), 'establish frame byte-identical');
  assert.equal(frames[1].ackId, 2);
  assert.equal(frames[1].requiresAck, true);
  const text = dec.decode(frames[1].payload);
  assert.ok(text.includes('7300123456789012345'), 'epoch id kept exactly: ' + text.slice(0, 120));
  const env = JSON.parse(text);
  assert.equal(env.type, 3);
  const inner = JSON.parse(env.payload);
  assert.equal(inner.tasks.length, 2, 'no task removed');
  assert.equal(inner.tasks[0].payload, JSON.stringify(JSON.parse(sendPayload)).replace('7123456789012345678', '7123456789012345678'));
  assert.ok(inner.tasks[0].payload.includes('"otid":"7123456789012345678"'));
  assert.equal(JSON.parse(inner.tasks[1].payload).last_read_watermark_ts, 1731571000000);
  assert.equal(inner.tasks[1].task_id, 4);
});

test('Unseen: unknown read marker -> request left alone and reported; non-advancing read untouched', () => {
  const readPayload = `{"thread_id":${THREAD},"last_read_watermark_ts":1731571860000,"sync_group":1}`;
  const req = h.taskRequest([{ label: '21', payload: readPayload, queue: THREAD, taskId: 4 }]);
  const unknown = mw.rewriteRequestText(req, { blockSeen: true, blockTyping: false, readWatermarks: new Map() });
  assert.equal(unknown.text, null, 'never rewritten to 0 (that would mark the chat unread)');
  assert.deepEqual(unknown.actions, [{ type: 'seen-unknown', thread: THREAD, label: '21', value: 1731571860000 }]);

  const notAdvancing = mw.rewriteRequestText(req, { blockSeen: true, blockTyping: false, readWatermarks: new Map([[THREAD, 1731571860000]]) });
  assert.equal(notAdvancing.text, null, 'goes out unchanged');
  assert.deepEqual(notAdvancing.actions, [{ type: 'seen-sent', thread: THREAD, value: 1731571860000 }]);

  // with Unseen off nothing changes, but the marker that goes out is noted
  const learnOnly = mw.rewriteRequestText(req, { blockSeen: false, blockTyping: false, learn: true, readWatermarks: new Map() });
  assert.equal(learnOnly.text, null);
  assert.deepEqual(learnOnly.actions, [{ type: 'seen-sent', thread: THREAD, value: 1731571860000 }]);

  const off = mw.rewriteRequestText(req, { blockSeen: false, blockTyping: true, readWatermarks: new Map() });
  assert.equal(off, null);
});

test('Unseen: the label-49 read task (thread_key, ..._timestamp_ms) is rewound too', () => {
  const t49 = `{"thread_key":${THREAD},"last_read_watermark_timestamp_ms":1790754536981,"sync_group":1}`;
  const t21 = `{"thread_id":${THREAD},"last_read_watermark_ts":1790754536981,"sync_group":1}`;
  const req = h.taskRequest([
    { label: '49', payload: t49, queue: THREAD, taskId: 7 },
    { label: '21', payload: t21, queue: THREAD, taskId: 8 },
  ]);
  const res = mw.rewriteRequestText(req, { blockSeen: true, blockTyping: false, readWatermarks: new Map([[THREAD, 1790750000000]]) });
  const tasks = JSON.parse(JSON.parse(res.text).payload).tasks;
  assert.equal(JSON.parse(tasks[0].payload).last_read_watermark_timestamp_ms, 1790750000000);
  assert.equal(JSON.parse(tasks[1].payload).last_read_watermark_ts, 1790750000000);
  assert.deepEqual(res.actions.map((a) => a.label), ['49', '21']);

  // "Mark as unread" (an older marker) is the user's own choice: left alone
  const unread = h.taskRequest([{ label: '49', payload: `{"thread_key":${THREAD},"last_read_watermark_timestamp_ms":1700000000000,"sync_group":1}`, queue: THREAD, taskId: 9 }]);
  assert.equal(mw.rewriteRequestText(unread, { blockSeen: true, blockTyping: false, readWatermarks: new Map([[THREAD, 1790750000000]]) }).text, null);
});

test('Unseen: a sent message that merely mentions last_read_watermark_ts is never touched', () => {
  const send = `{"thread_id":${THREAD},"otid":"7123456789012345678","text":"grep last_read_watermark_ts in the logs","sync_group":1}`;
  const req = h.taskRequest([{ label: '46', payload: send, queue: THREAD, taskId: 3 }]);
  assert.equal(mw.rewriteRequestText(req, { blockSeen: true, blockTyping: true, readWatermarks: new Map() }), null);
});

test('Unseen: typing indicator is turned into "not typing"', () => {
  const req = h.typingRequest({ threadKey: THREAD, typing: 1 });
  const res = mw.rewriteOutgoingBytes(h.concat(h.dgwEstablish(8), h.dgwData(8, req, { requiresAck: false })), 'dgw', {
    blockSeen: true,
    blockTyping: true,
    readWatermarks: new Map(),
  });
  assert.ok(res);
  assert.equal(res.actions[0].type, 'typing-blocked');
  const frames = mw.dgwParse(res.bytes);
  const env = JSON.parse(dec.decode(frames[1].payload));
  assert.equal(env.type, 4);
  const inner = JSON.parse(env.payload);
  assert.equal(JSON.parse(inner.payload).is_typing, 0);
  assert.equal(frames[1].requiresAck, false);

  const stopTyping = mw.rewriteRequestText(h.typingRequest({ threadKey: THREAD, typing: 0 }), { blockSeen: true, blockTyping: true, readWatermarks: new Map() });
  assert.equal(stopTyping, null, '"stopped typing" passes untouched');
});

test('Unseen: MQTT /ls_req publish is rewritten with a correct remaining length', () => {
  const readPayload = `{"thread_id":${THREAD},"last_read_watermark_ts":1731571860000,"sync_group":1}`;
  const req = h.taskRequest([{ label: '21', payload: readPayload, queue: THREAD, taskId: 4 }]);
  const pkt = h.mqttPublish('/ls_req', req, { qos: 1, packetId: 77 });
  const res = mw.rewriteOutgoingBytes(pkt, 'mqtt', { blockSeen: true, blockTyping: true, readWatermarks: new Map([[THREAD, 1731571000000]]) });
  assert.ok(res && res.bytes);
  const parsed = mw.mqttParse(res.bytes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].topic, '/ls_req');
  assert.equal(parsed[0].packetId, 77);
  const inner = JSON.parse(JSON.parse(dec.decode(parsed[0].payload)).payload);
  assert.equal(JSON.parse(inner.tasks[0].payload).last_read_watermark_ts, 1731571000000);
});

test('socketKind classifies Messenger sockets', () => {
  assert.equal(mw.socketKind('wss://gateway.facebook.com/ws/lightspeed?x-dgw-appid=1'), 'dgw');
  assert.equal(mw.socketKind('wss://gateway.messenger.com/ws/lightspeed'), 'dgw');
  assert.equal(mw.socketKind('wss://edge-chat.facebook.com/chat?region=sin'), 'mqtt');
  assert.equal(mw.socketKind('wss://web-chat-e2ee.facebook.com/ws/chat'), 'e2ee');
  assert.equal(mw.socketKind('wss://example.com/'), 'other');
});

/* ---------------- downloads ---------------- */

const V = 'https://video-sin6-1.xx.fbcdn.net/v/t42.1790-2/';

test('downloads: video files are found in every data layout Facebook uses', () => {
  // player props (implementations[].data.hdSrc / sdSrc)
  let list = mw.findVideoSources({ videoID: '111', implementations: [{ data: {} }, { data: { hdSrc: V + 'h.mp4?a=1', sdSrc: V + 's.mp4?a=1' } }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].hd, V + 'h.mp4?a=1');
  assert.equal(list[0].sd, V + 's.mp4?a=1');
  // page data: video { __typename: Video, id, videoDeliveryLegacyFields }
  list = mw.findVideoSources({ data: { video: { __typename: 'Video', id: '22222', videoDeliveryLegacyFields: { browser_native_hd_url: V + 'h2.mp4', browser_native_sd_url: V + 's2.mp4' } } } });
  assert.deepEqual(list, [{ id: '22222', hd: V + 'h2.mp4', sd: V + 's2.mp4', dash: '' }]);
  // older names: playable_url / playable_url_quality_hd, hd_src / sd_src
  assert.equal(mw.findVideoSources({ id: '33333', playable_url_quality_hd: V + 'h3.mp4', playable_url: V + 's3.mp4' })[0].hd, V + 'h3.mp4');
  assert.equal(mw.findVideoSources({ video_id: '44444', sd_src: V + 's4.mp4' })[0].sd, V + 's4.mp4');
  // newer: videoDeliveryResponseResult.progressive_urls with metadata.quality
  list = mw.findVideoSources({ video: { __typename: 'Video', id: '55555', videoDeliveryResponseFragment: { videoDeliveryResponseResult: { progressive_urls: [{ progressive_url: V + 's5.mp4', metadata: { quality: 'SD' } }, { progressive_url: V + 'h5.mp4', metadata: { quality: 'HD' } }] } } } });
  assert.deepEqual(list, [{ id: '55555', hd: V + 'h5.mp4', sd: V + 's5.mp4', dash: '' }]);
});

test('downloads: never a DASH byte range, a manifest address, or a non-Facebook host', () => {
  assert.equal(mw.isProgressiveUrl(V + 'x.mp4?bytestart=0&byteend=999'), false);
  assert.equal(mw.isProgressiveUrl(V + 'x.mpd?a=1'), false);
  assert.equal(mw.isProgressiveUrl('https://evil.example/x.mp4'), false);
  assert.equal(mw.isProgressiveUrl('http://video.xx.fbcdn.net/x.mp4'), false);
  assert.equal(mw.isProgressiveUrl(V + 'x.mp4?_nc_ht=1'), true);
  assert.deepEqual(mw.findVideoSources({ id: '66666', playable_url: V + 'x.mp4?bytestart=0&byteend=1' }), []);
});

test('downloads: the right video among several, and React/class objects are not walked', () => {
  const list = mw.findVideoSources({
    feed: [
      { __typename: 'Video', id: '70001', videoDeliveryLegacyFields: { browser_native_hd_url: V + 'a.mp4' } },
      { __typename: 'Video', id: '70002', videoDeliveryLegacyFields: { browser_native_hd_url: V + 'b.mp4' } },
    ],
  });
  assert.equal(mw.pickVideo(list, '70002').hd, V + 'b.mp4');
  assert.equal(mw.pickVideo(list, '').hd, V + 'a.mp4', 'closest (first met) without an id');
  class Store {
    constructor() {
      this.video = { id: '70003', hd_src: V + 'c.mp4' };
    }
  }
  assert.deepEqual(mw.findVideoSources({ environment: { video: { id: '70004', hd_src: V + 'd.mp4' } }, store: new Store() }), [], 'Relay environment and class instances skipped');
  // cycles do not hang the walk
  const a = { id: '70005' };
  a.self = a;
  a.list = [a];
  assert.deepEqual(mw.findVideoSources(a), []);
});

test('downloads: DASH manifest gives the best picture and best sound tracks', () => {
  const xml =
    '<?xml version="1.0"?><MPD><Period><AdaptationSet contentType="video">' +
    `<Representation mimeType="video/mp4" bandwidth="400000" height="360"><BaseURL>${V}v360.mp4?a=1&amp;b=2</BaseURL></Representation>` +
    `<Representation mimeType="video/mp4" bandwidth="900000" height="720"><BaseURL>${V}v720.mp4?a=1</BaseURL></Representation>` +
    '</AdaptationSet><AdaptationSet><Representation mimeType="audio/mp4" bandwidth="64000"><BaseURL>' + V + 'a64.mp4</BaseURL></Representation>' +
    `<Representation mimeType="audio/mp4" bandwidth="128000"><BaseURL>${V}a128.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  assert.deepEqual(mw.dashTracks(xml), { video: V + 'v720.mp4?a=1', height: 720, audio: V + 'a128.mp4' });
  assert.deepEqual(mw.dashTracks(encodeURIComponent(xml)), { video: V + 'v720.mp4?a=1', height: 720, audio: V + 'a128.mp4' }, 'URL-encoded manifests too');
  assert.equal(mw.dashTracks('<MPD></MPD>'), null);
  const found = mw.findVideoSources({ video: { __typename: 'Video', id: '80001', videoDeliveryResponseFragment: { videoDeliveryResponseResult: { dash_manifests: [{ manifest_xml: xml }] } } } });
  assert.equal(found[0].id, '80001');
  assert.equal(found[0].dash, xml);
});

test('downloads: video ids in Facebook addresses', () => {
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/reel/1234567890123456/?s=ifu'), '1234567890123456');
  assert.equal(mw.videoIdFromUrl('/reel/987654321/'), '987654321');
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/watch/?v=24680246802468&ref=x'), '24680246802468');
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/watch/live/?v=13579135791'), '13579135791');
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/SomePage/videos/a-title-here/112233445566/'), '112233445566');
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/SomePage/videos/112233445566'), '112233445566');
  assert.equal(mw.videoIdFromUrl('https://web.facebook.com/video.php?v=99887766554'), '99887766554');
  assert.equal(mw.videoIdFromUrl('https://www.facebook.com/photo/?fbid=1234567'), '');
  assert.equal(mw.videoIdFromUrl('https://evil.example/reel/123456789'), '');
});

test('downloads: page HTML JSON blocks are parsed (escaped slashes), others skipped', () => {
  const data = { video: { __typename: 'Video', id: '424242424', videoDeliveryLegacyFields: { browser_native_hd_url: V + 'r.mp4?x=1' } } };
  const html = `<html><script type="application/json" data-sjs>{"nothing":"here"}</script><script type="application/json" data-content-len="9" data-sjs>${JSON.stringify(data).replace(/\//g, '\\/')}</script><script>var x = "browser_native_hd_url";</script></html>`;
  const blocks = mw.videoJsonFromHtml(html);
  assert.equal(blocks.length, 1);
  assert.equal(mw.pickVideo(mw.findVideoSources(blocks[0], { budget: 1e5, maxDepth: 80 }), '424242424').hd, V + 'r.mp4?x=1');
});

test('downloads: photos — same picture (file name), largest copy wins', () => {
  const small = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/123_456_789_n.jpg?stp=dst-jpg_s320x320_tt6&oh=1';
  const big = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/123_456_789_n.jpg?stp=dst-jpg_s2048x2048&oh=2';
  const other = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/999_888_777_n.jpg?stp=dst-jpg_s4096x4096&oh=3';
  assert.equal(mw.imageFileKey(small), '123_456_789_n.jpg');
  assert.equal(mw.stpArea(small), 320 * 320);
  assert.equal(mw.stpArea('https://x.fbcdn.net/a.jpg?stp=c0.5000x0.5000f_dst-jpg_e15_p480x480_q65&oh=1'), 480 * 480);
  assert.equal(mw.stpArea('https://x.fbcdn.net/a.jpg?oh=1'), 0);
  const copies = mw.findImageCopies({ photo: { image: { uri: small, width: 320, height: 213 }, viewer_image: { uri: big, width: 2048, height: 1365 } }, next: { image: { uri: other, width: 4096, height: 4096 } } }, mw.imageFileKey(small));
  assert.equal(copies.length, 2, 'a different photo is never picked');
  assert.equal(mw.bestImage(small, copies), big);
  // Messenger attachment style keys (largePreviewUrl + largePreviewWidth)
  const msgr = mw.findImageCopies({ previewUrl: small, previewWidth: 320, previewHeight: 213, largePreviewUrl: big, largePreviewWidth: 1600, largePreviewHeight: 1066 }, mw.imageFileKey(small));
  assert.equal(mw.bestImage(small, msgr), big);
  assert.equal(mw.bestImage(small, []), small, 'the shown copy when nothing larger is known');
});

test('downloads: file names stay inside Downloads/Facebook with a media extension', async () => {
  const { downloadFileName, isDownloadableUrl } = await import('../../extension/lib/downloads.js');
  assert.equal(downloadFileName('facebook-video-123-hd.mp4', V + 'a.mp4'), 'Facebook/facebook-video-123-hd.mp4');
  assert.equal(downloadFileName('../../Windows/System32/evil.exe', 'https://scontent.xx.fbcdn.net/a.jpg'), 'Facebook/Windows-System32-evil.jpg');
  assert.equal(downloadFileName('', V + 'a.mp4').endsWith('.mp4'), true);
  assert.equal(downloadFileName('con. ', 'https://x.fbcdn.net/a').startsWith('Facebook/con'), true);
  assert.equal(isDownloadableUrl(V + 'a.mp4'), true);
  assert.equal(isDownloadableUrl('https://cdn.fbsbx.com/v/t59/file.jpg'), true);
  assert.equal(isDownloadableUrl('https://fbcdn.net.evil.example/a.mp4'), false);
  assert.equal(isDownloadableUrl('javascript:alert(1)'), false);
});
