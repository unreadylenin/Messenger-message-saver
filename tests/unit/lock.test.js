'use strict';
// Unit tests for the PIN lock (extension/lib/lock.js) with an in-memory chrome.storage.
// Run: node --test tests/unit/lock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function fakeArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  };
}

globalThis.chrome = { storage: { local: fakeArea(), session: fakeArea() } };
const load = () => import('../../extension/lib/lock.js');

test('PIN rules: 4-12 digits, Bangla digits count the same', async () => {
  const lock = await load();
  assert.equal(lock.validPin('1234'), true);
  assert.equal(lock.validPin('১২৩৪'), true);
  assert.equal(lock.normalizePin('১২৩৪৫'), '12345');
  assert.equal(lock.validPin('123'), false);
  assert.equal(lock.validPin('1234567890123'), false);
  assert.equal(lock.validPin('12a4'), false);
  await assert.rejects(lock.setPin('12', { iterations: 1000 }), /4 to 12 digits/);
});

test('set, unlock, wrong tries, the 30-second wait, removal', async () => {
  const lock = await load();
  assert.equal(await lock.isLockOn(), false);
  assert.equal(await lock.isUnlocked(), true, 'no lock: always open');

  await lock.setPin('2468', { iterations: 1000 });
  const stored = chrome.storage.local.data.lock;
  assert.ok(stored && stored.hash && stored.salt, 'hash and salt stored');
  assert.ok(!JSON.stringify(stored).includes('2468'), 'the PIN itself is never stored');
  assert.equal(await lock.isLockOn(), true);
  assert.equal(await lock.isUnlocked(), true, 'setting the PIN unlocks this session');

  await lock.lockNow();
  assert.equal(await lock.isUnlocked(), false);
  assert.deepEqual(await lock.verifyPin('২৪৬৮'), { ok: true, waitMs: 0 }, 'Bangla digits unlock too');
  assert.equal(await lock.isUnlocked(), true);

  await lock.lockNow();
  for (let i = 0; i < 4; i++) assert.deepEqual(await lock.verifyPin('0000'), { ok: false, waitMs: 0 });
  const fifth = await lock.verifyPin('0000');
  assert.equal(fifth.ok, false);
  assert.ok(fifth.waitMs > 25000, '5th wrong try starts a wait');
  const during = await lock.verifyPin('2468');
  assert.equal(during.ok, false, 'even the right PIN waits');
  assert.ok(during.waitMs > 0);

  chrome.storage.session.data.pinFails.until = Date.now() - 1; // the wait is over
  assert.equal((await lock.verifyPin('2468')).ok, true);

  assert.equal((await lock.removeLock('1111')).ok, false, 'removal needs the PIN');
  assert.equal(await lock.isLockOn(), true);
  assert.equal((await lock.removeLock('2468')).ok, true);
  assert.equal(await lock.isLockOn(), false);
  assert.equal(chrome.storage.session.data.unlockedUntil, undefined);
});

test('an expired session is locked again; forgetLock removes the lock', async () => {
  const lock = await load();
  await lock.setPin('13579', { iterations: 1000 });
  chrome.storage.session.data.unlockedUntil = Date.now() - 1000;
  assert.equal(await lock.isUnlocked(), false);
  await lock.forgetLock();
  assert.equal(await lock.isLockOn(), false);
  assert.equal(await lock.isUnlocked(), true);
});

test('a tampered lock record does not open the lock', async () => {
  const lock = await load();
  await lock.setPin('8642', { iterations: 1000 });
  await lock.lockNow();
  chrome.storage.local.data.lock.hash = Buffer.from('x'.repeat(32)).toString('base64');
  assert.equal((await lock.verifyPin('8642')).ok, false);
  await lock.forgetLock();
});
