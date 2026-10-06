/**
 * Refer & Earn for the hard-paywall cohort: /referral/code says
 * rewardsEligible=false (the app hides Refer & Earn) and /referral/redeem
 * never promises credits that won't be paid. Legacy users: unchanged.
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

const { db, store, FieldValue } = createFakeFirestore();
const created = { oldie: '2026-09-01T00:00:00Z', oldFriend: '2026-09-02T00:00:00Z', fresh: '2026-10-08T00:00:00Z' };
const admin = {
  firestore: { FieldValue },
  auth: () => ({ getUser: async (uid) => ({ metadata: { creationTime: new Date(created[uid]).toUTCString() } }) }),
};
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db, getAdmin: () => admin },
  './firestoreAdmin': { getDb: () => db, getAdmin: () => admin },
  'firebase-admin': admin,
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
process.env.HARD_PAYWALL_MIN_VERSION_CODE = '51';
process.env.AI_REQUIRE_TOKEN = 'false';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const router = require('../routes/aiAccess');
console.log = quiet;
const app = express();
app.use(express.json());
app.use('/', router);
let base;
const NEW_APP = { 'x-app-version-code': '51' };
const call = async (method, path, uid, body, headers = NEW_APP) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-user-uid': uid, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  store.set('users/oldie', { credits: 0, referralCode: 'OLD111' });
  store.set('users/oldFriend', { credits: 0 });
  store.set('users/fresh', { credits: 0 });
  console.log('Referral routes vs hard cohort\n');

  await t('legacy user: /referral/code rewardsEligible = true (program unchanged)', async () => {
    const r = await call('GET', '/referral/code', 'oldie');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.rewardsEligible, true);
    assert.strictEqual(r.body.code, 'OLD111');
  });

  await t('hard-cohort user: /referral/code rewardsEligible = false', async () => {
    const r = await call('GET', '/referral/code', 'fresh');
    assert.strictEqual(r.body.rewardsEligible, false);
  });

  await t('legacy redeemer + legacy referrer → original message with the credit amount', async () => {
    const r = await call('POST', '/referral/redeem', 'oldFriend', { code: 'OLD111' });
    assert.strictEqual(r.status, 200);
    assert.ok(/earns \d+ credits/.test(r.body.message), r.body.message);
  });

  await t('hard-cohort redeemer → neutral message, no credit promise', async () => {
    const r = await call('POST', '/referral/redeem', 'fresh', { code: 'OLD111' });
    assert.strictEqual(r.status, 200);
    assert.ok(!/credit/i.test(r.body.message), r.body.message);
    assert.strictEqual(store.get('users/fresh').referredByUid, 'oldie'); // still linked
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
