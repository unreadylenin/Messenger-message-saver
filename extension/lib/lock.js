// Optional PIN lock for the Saved Messages page and the popup's message list.
//
// The PIN itself is never stored: only a PBKDF2-SHA-256 hash with a random salt, in
// chrome.storage.local ("lock"). Whether this browser session is unlocked lives in
// chrome.storage.session, which content scripts cannot read and which Chrome empties when the
// browser closes. This keeps other people who use the computer out of the saved messages; it
// does not encrypt the database (the UI says so).

const ITERATIONS = 600000;
export const LOCK_IDLE_MS = 15 * 60 * 1000; // locks again after 15 minutes without use
const MAX_TRIES = 5; // then a 30-second wait
const WAIT_MS = 30 * 1000;
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Bangla digits typed on a Bangla keyboard count as the same PIN. */
export function normalizePin(pin) {
  return String(pin === undefined || pin === null ? '' : pin)
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
    .replace(/\s+/g, '');
}

export function validPin(pin) {
  return /^\d{4,12}$/.test(normalizePin(pin));
}

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  return Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
}

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizePin(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Compares without stopping at the first different byte. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function getLock() {
  const { lock } = await chrome.storage.local.get('lock');
  return lock && typeof lock.hash === 'string' && typeof lock.salt === 'string' ? lock : null;
}

export async function isLockOn() {
  return !!(await getLock());
}

/** True when there is no lock, or this browser session was unlocked recently. */
export async function isUnlocked() {
  if (!(await isLockOn())) return true;
  const { unlockedUntil = 0 } = await chrome.storage.session.get('unlockedUntil');
  return unlockedUntil > Date.now();
}

/** Keeps an unlocked session open for another 15 minutes. */
export async function touch() {
  await chrome.storage.session.set({ unlockedUntil: Date.now() + LOCK_IDLE_MS });
}

export async function lockNow() {
  await chrome.storage.session.set({ unlockedUntil: 0 });
}

export async function setPin(pin, { iterations = ITERATIONS } = {}) {
  if (!validPin(pin)) {
    const err = new Error('A PIN has 4 to 12 digits.');
    err.code = 'invalid';
    throw err;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations);
  await chrome.storage.local.set({ lock: { v: 1, salt: toB64(salt), hash: toB64(hash), iterations } });
  await chrome.storage.session.set({ pinFails: { n: 0, until: 0 } });
  await touch();
}

/**
 * Checks a PIN. Returns { ok, waitMs }: after every 5th wrong try, even the right PIN is refused
 * for 30 seconds (waitMs tells how long is left).
 */
export async function verifyPin(pin) {
  const lock = await getLock();
  if (!lock) return { ok: true, waitMs: 0 };
  const now = Date.now();
  const { pinFails } = await chrome.storage.session.get('pinFails');
  const fails = pinFails && typeof pinFails === 'object' ? pinFails : { n: 0, until: 0 };
  if (fails.until > now) return { ok: false, waitMs: fails.until - now };
  const hash = await derive(pin, fromB64(lock.salt), lock.iterations || ITERATIONS);
  if (sameBytes(hash, fromB64(lock.hash))) {
    await chrome.storage.session.set({ pinFails: { n: 0, until: 0 } });
    await touch();
    return { ok: true, waitMs: 0 };
  }
  const n = (fails.n || 0) + 1;
  const until = n % MAX_TRIES === 0 ? now + WAIT_MS : 0;
  await chrome.storage.session.set({ pinFails: { n, until } });
  return { ok: false, waitMs: until ? WAIT_MS : 0 };
}

/** Turns the lock off; needs the current PIN. */
export async function removeLock(pin) {
  const r = await verifyPin(pin);
  if (!r.ok) return r;
  await forgetLock();
  return r;
}

/** Removes the lock without the PIN (only after all saved data was deleted). */
export async function forgetLock() {
  await chrome.storage.local.remove('lock');
  await chrome.storage.session.remove(['unlockedUntil', 'pinFails']);
}
