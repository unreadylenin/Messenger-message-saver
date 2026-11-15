'use strict';
// Builders for realistic Messenger LightSpeed / DGW / MQTT test data.

const enc = new TextEncoder();

function i64(v) {
  return [19, String(v)];
}

/** Builds a stored-procedure call [5, name, ...args] from an {index: value} map. */
function call(name, byIndex, length) {
  const max = Math.max(length || 0, ...Object.keys(byIndex).map(Number)) + 1;
  const args = new Array(max).fill([9]);
  for (const [k, v] of Object.entries(byIndex)) args[Number(k)] = v;
  return [5, name, ...args];
}

function insertMessage({ text, threadKey, ts, id, senderId, unsent = false, proc = 'insertMessage', otid = '7000000000000000001' }) {
  return call(
    proc,
    {
      0: text,
      2: i64(80),
      3: i64(threadKey),
      5: i64(ts),
      6: i64(ts),
      7: i64(0),
      8: id,
      9: otid,
      10: i64(senderId),
      12: false,
      15: i64(3),
      16: i64(3),
      17: unsent,
      18: unsent ? i64(ts + 5000) : [9],
    },
    80
  );
}

function lsPayload(steps, name = null) {
  return JSON.stringify({ name, step: [1, ...steps] });
}

/** Server -> client response envelope as carried in a DGW data frame. */
function responseEnvelope(steps, requestId = 7) {
  return JSON.stringify({ request_id: requestId, payload: lsPayload(steps), sp: ['insertMessage'], target: 1 });
}

/** Client -> server task request (type 3). Uses a raw big epoch id on purpose. */
function taskRequest(tasks, { epoch = '7300123456789012345', requestId = 12 } = {}) {
  const tasksJson = tasks
    .map(
      (t) =>
        `{"failure_count":null,"label":"${t.label}","payload":${JSON.stringify(t.payload)},"queue_name":"${t.queue}","task_id":${t.taskId}}`
    )
    .join(',');
  const inner = `{"epoch_id":${epoch},"tasks":[${tasksJson}],"version_id":"9876543210123456"}`;
  return `{"app_id":"2220391788200892","payload":${JSON.stringify(inner)},"request_id":${requestId},"type":3}`;
}

function typingRequest({ threadKey, typing = 1 }) {
  const inner = JSON.stringify({
    label: '3',
    payload: `{"thread_key":${threadKey},"is_group_thread":0,"is_typing":${typing},"attribution":0,"sync_group":1,"thread_type":1}`,
    version: '9876543210123456',
  });
  return JSON.stringify({ app_id: '2220391788200892', payload: inner, request_id: 13, type: 4 });
}

function u24(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
}

function dgwEstablish(streamId, json = '{}') {
  const p = enc.encode(json);
  return Uint8Array.from([15, streamId & 0xff, streamId >> 8, ...u24(p.length), ...p]);
}

function dgwData(streamId, text, { ackId = 1, requiresAck = true } = {}) {
  const p = enc.encode(text);
  const len = 2 + p.length;
  return Uint8Array.from([13, streamId & 0xff, streamId >> 8, ...u24(len), ackId & 0xff, ((ackId >> 8) & 0x7f) | (requiresAck ? 0x80 : 0), ...p]);
}

function dgwAck(streamId, ackId) {
  return Uint8Array.from([12, streamId & 0xff, streamId >> 8, 2, 0, 0, ackId & 0xff, ackId >> 8]);
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function mqttPublish(topic, text, { qos = 1, packetId = 5 } = {}) {
  const t = enc.encode(topic);
  const p = enc.encode(text);
  const body = [t.length >> 8, t.length & 0xff, ...t];
  if (qos > 0) body.push(packetId >> 8, packetId & 0xff);
  body.push(...p);
  const rl = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    rl.push(d);
  } while (n > 0);
  return Uint8Array.from([0x30 | (qos << 1), ...rl, ...body]);
}

module.exports = {
  i64,
  call,
  insertMessage,
  lsPayload,
  responseEnvelope,
  taskRequest,
  typingRequest,
  dgwEstablish,
  dgwData,
  dgwAck,
  concat,
  mqttPublish,
};
