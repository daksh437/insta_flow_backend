/**
 * POST /play/rtdn: only OIDC-verified Pub/Sub pushes are processed; state
 * always comes from the Play API via subscriptionSync; Play outages return
 * 503 so Pub/Sub retries.
 */
const assert = require('assert');
const Module = require('module');
const http = require('http');
const express = require('express');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

// pubsubAuth fails closed without configuration (real module, before stubbing).
const realAuth = require('../utils/pubsubAuth');

const { db, store } = createFakeFirestore();
let authOk = true;
const calls = [];
let syncResult = { status: 'synced', uid: 'u1', granted: true, amount: 100 };
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db },
  '../utils/pubsubAuth': { verifyPushRequest: async () => (authOk ? { ok: true } : { ok: false, reason: 'bad token' }) },
  '../utils/playVerify': { PACKAGE_NAME: 'com.instaflow' },
  '../services/subscriptionSync': {
    syncSubscription: async (a) => { calls.push(['sync', a]); return syncResult; },
    handleVoided: async (a) => { calls.push(['voided', a]); return { status: 'clawed_back' }; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const router = require('../routes/play');
const app = express();
app.use(express.json());
app.use('/play', router);

const push = (payload, headers = { authorization: 'Bearer x' }) => fetch(`${base}/play/rtdn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } }),
});
const subMsg = (type, token = 'tok1') => ({
  packageName: 'com.instaflow',
  subscriptionNotification: { notificationType: type, purchaseToken: token, subscriptionId: 'instaflow_starter_299' },
});
let base;

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  console.log = quiet;
  console.log('RTDN tests\n');

  await t('pubsubAuth without RTDN_AUDIENCE / RTDN_PUSH_SA_EMAIL → rejects (fail closed)', async () => {
    delete process.env.RTDN_AUDIENCE; delete process.env.RTDN_PUSH_SA_EMAIL;
    const r = await realAuth.verifyPushRequest({ headers: { authorization: 'Bearer anything' } });
    assert.strictEqual(r.ok, false);
  });

  await t('pubsubAuth with config but no bearer token → rejects', async () => {
    process.env.RTDN_AUDIENCE = 'https://x/play/rtdn'; process.env.RTDN_PUSH_SA_EMAIL = 'push@x.iam.gserviceaccount.com';
    const r = await realAuth.verifyPushRequest({ headers: {} });
    assert.strictEqual(r.ok, false);
  });

  await t('unverified push → 401, nothing processed', async () => {
    authOk = false; calls.length = 0;
    const r = await push(subMsg(4));
    assert.strictEqual(r.status, 401);
    assert.strictEqual(calls.length, 0);
    authOk = true;
  });

  await t('test notification → 200', async () => {
    const r = await push({ packageName: 'com.instaflow', testNotification: { version: '1.0' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).test, true);
  });

  await t('PURCHASED / RENEWED → synced from Play with token + product', async () => {
    calls.length = 0;
    for (const type of [4, 2]) assert.strictEqual((await push(subMsg(type))).status, 200);
    assert.deepStrictEqual(calls.map((c) => c[1]), [
      { purchaseToken: 'tok1', productId: 'instaflow_starter_299' },
      { purchaseToken: 'tok1', productId: 'instaflow_starter_299' },
    ]);
  });

  await t('Play unavailable → 503 so Pub/Sub retries', async () => {
    syncResult = { status: 'unavailable', reason: 'play_503' };
    assert.strictEqual((await push(subMsg(2))).status, 503);
    syncResult = { status: 'synced', uid: 'u1' };
  });

  await t('unowned token → 200 and remembered in rtdn_unmatched', async () => {
    syncResult = { status: 'unowned', reason: 'no owner' };
    assert.strictEqual((await push(subMsg(4, 'tokX'))).status, 200);
    assert.ok([...store.keys()].some((k) => k.startsWith('rtdn_unmatched/')));
    syncResult = { status: 'synced', uid: 'u1' };
  });

  await t('voided purchase → clawback handler with token + order', async () => {
    calls.length = 0;
    const r = await push({ packageName: 'com.instaflow', voidedPurchaseNotification: { purchaseToken: 'tok1', orderId: 'GPA.1', productType: 1 } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls[0], ['voided', { purchaseToken: 'tok1', orderId: 'GPA.1' }]);
  });

  await t('another package / unreadable body → 200, ignored', async () => {
    calls.length = 0;
    assert.strictEqual((await push({ ...subMsg(4), packageName: 'com.other' })).status, 200);
    const r = await fetch(`${base}/play/rtdn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: '{}' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls.length, 0);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
