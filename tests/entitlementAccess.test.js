/**
 * Active entitlement (trial or paid): text tools are free under one shared
 * hidden 50/day fair-use cap; image tools always cost credits; without an
 * entitlement everything costs credits. A failed text generation gives its
 * fair-use slot back.
 */
const assert = require('assert');
const Module = require('module');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const { db, store, FieldValue } = createFakeFirestore();
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db, getAdmin: () => ({ firestore: { FieldValue } }) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.CREDITS_ENABLED = 'true';
process.env.AI_REQUIRE_TOKEN = 'false'; // trust the x-user-uid header in this test
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const { requireAiAccess, refundAiCharge } = require('../middleware/aiAccess');
console.log = quiet;

const future = () => new Date(Date.now() + 86400000);
const today = new Date().toISOString().slice(0, 10);
let n = 0;

/** Runs the middleware for [path]; resolves { status, body, next }. */
function call(uid, path) {
  return new Promise((resolve) => {
    const req = { headers: { 'x-user-uid': uid, 'x-idempotency-key': `k${++n}` }, body: {}, baseUrl: '/ai', path, url: path };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, next: false, req }); },
    };
    requireAiAccess(req, res, () => resolve({ status: 200, next: true, req }));
  });
}
const credits = (uid) => store.get(`users/${uid}`).credits;
const used = (uid) => (store.get(`users/${uid}/text_usage/${today}`) || {}).count || 0;

(async () => {
  console.log('Entitlement access tests\n');
  store.set('users/sub', { credits: 100, entitlement: { active: true, expiresAt: future() } });
  store.set('users/free', { credits: 100 });
  store.set('users/lapsed', { credits: 100, entitlement: { active: true, everPaid: true, expiresAt: new Date(Date.now() - 1000) } });

  await t('entitled: caption is free and counts one fair-use slot', async () => {
    const r = await call('sub', '/generate-captions');
    assert.strictEqual(r.next, true);
    assert.strictEqual(credits('sub'), 100);
    assert.strictEqual(used('sub'), 1);
    assert.strictEqual(r.req.aiAccess.unlimitedText, true);
  });

  await t('entitled: every text tool shares the same cap (reel script, content engine, bio)', async () => {
    for (const p of ['/reels-script', '/content-engine', '/generate-bio']) assert.strictEqual((await call('sub', p)).next, true);
    assert.strictEqual(used('sub'), 4);
    assert.strictEqual(credits('sub'), 100);
  });

  await t('entitled: image tool still costs credits', async () => {
    const r = await call('sub', '/image/generate');
    assert.strictEqual(r.next, true);
    assert.strictEqual(credits('sub'), 75);
  });

  await t('entitled: 51st text generation of the day → 429 FAIR_USE_LIMIT, message has no number', async () => {
    store.set(`users/sub/text_usage/${today}`, { count: 50 });
    const r = await call('sub', '/generate-captions');
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.error, 'FAIR_USE_LIMIT');
    assert.ok(!/\d/.test(r.body.message.replace('UTC', '')), `message shows a number: ${r.body.message}`);
    assert.strictEqual(credits('sub'), 75);
  });

  await t('entitled: failed text generation gives the slot back', async () => {
    store.set(`users/sub/text_usage/${today}`, { count: 10 });
    const r = await call('sub', '/generate-captions');
    assert.strictEqual(used('sub'), 11);
    assert.strictEqual(await refundAiCharge('sub', r.req.idempotencyKey, '/ai/generate-captions'), true);
    assert.strictEqual(used('sub'), 10);
    assert.strictEqual(credits('sub'), 75);
  });

  await t('no entitlement: caption costs credits', async () => {
    await call('free', '/generate-captions');
    assert.strictEqual(credits('free'), 99);
    assert.strictEqual(used('free'), 0);
  });

  await t('trial/subscription ended: text tools cost credits again', async () => {
    await call('lapsed', '/reels-script');
    assert.strictEqual(credits('lapsed'), 95);
  });

  await t('no entitlement, not enough credits → 403 INSUFFICIENT_CREDITS', async () => {
    store.set('users/broke', { credits: 0 });
    const r = await call('broke', '/generate-captions');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'INSUFFICIENT_CREDITS');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
