/**
 * New users (created after RELEASE_AT) never get free credits: no welcome
 * gift, no daily credits; Instagram/YouTube rewards only with an active
 * entitlement. Existing users keep every reward exactly as before.
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
const created = { oldie: '2026-09-01T00:00:00Z', fresh: '2026-10-08T00:00:00Z', payer: '2026-10-08T00:00:00Z' };
const stubs = {
  '../utils/firestoreAdmin': {
    getDb: () => db,
    getAdmin: () => ({
      firestore: { FieldValue },
      auth: () => ({ getUser: async (uid) => ({ metadata: { creationTime: new Date(created[uid]).toUTCString() } }) }),
    }),
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
process.env.AI_REQUIRE_TOKEN = 'false';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const router = require('../routes/rewards');
console.log = quiet;
const app = express();
app.use(express.json());
app.use('/rewards', router);
let base;
const post = async (uid, path) => {
  const r = await fetch(`${base}/rewards/${path}`, { method: 'POST', headers: { 'x-user-uid': uid } });
  return { status: r.status, body: await r.json() };
};
const status = async (uid) => (await fetch(`${base}/rewards/status`, { headers: { 'x-user-uid': uid } })).json();
const credits = (uid) => store.get(`users/${uid}`).credits || 0;

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  store.set('users/oldie', { credits: 0 });
  store.set('users/fresh', { credits: 0 });
  store.set('users/payer', { credits: 100, entitlement: { active: true, expiresAt: new Date(Date.now() + 86400000) } });
  console.log('Rewards eligibility tests\n');

  await t('existing user: welcome gift, daily, Instagram, YouTube all still work', async () => {
    for (const p of ['claim-signup', 'claim-daily', 'claim-instagram-follow', 'claim-youtube-subscribe']) {
      const r = await post('oldie', p);
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.body.granted, true, p);
    }
    assert.strictEqual(credits('oldie'), 50 + 5 + 20 + 20);
    const s = await status('oldie');
    assert.deepStrictEqual(s.eligible, { signupBonus: true, dailyLogin: true, instagramFollow: true, youtubeSubscribe: true });
  });

  await t('new user without entitlement: every claim → 403 NOT_ELIGIBLE, 0 credits', async () => {
    for (const p of ['claim-signup', 'claim-daily', 'claim-instagram-follow', 'claim-youtube-subscribe']) {
      const r = await post('fresh', p);
      assert.strictEqual(r.status, 403, p);
      assert.strictEqual(r.body.error, 'NOT_ELIGIBLE', p);
    }
    assert.strictEqual(credits('fresh'), 0);
    const s = await status('fresh');
    assert.deepStrictEqual(s.eligible, { signupBonus: false, dailyLogin: false, instagramFollow: false, youtubeSubscribe: false });
  });

  await t('new user with an active entitlement: Instagram/YouTube yes, welcome/daily still no', async () => {
    assert.strictEqual((await post('payer', 'claim-signup')).status, 403);
    assert.strictEqual((await post('payer', 'claim-daily')).status, 403);
    assert.strictEqual((await post('payer', 'claim-instagram-follow')).body.granted, true);
    assert.strictEqual((await post('payer', 'claim-youtube-subscribe')).body.granted, true);
    assert.strictEqual(credits('payer'), 140);
    const s = await status('payer');
    assert.deepStrictEqual(s.eligible, { signupBonus: false, dailyLogin: false, instagramFollow: true, youtubeSubscribe: true });
  });

  await t('RELEASE_AT unset → nobody is new (all rewards open, as today)', async () => {
    delete process.env.RELEASE_AT;
    store.set('users/fresh', { credits: 0 });
    assert.strictEqual((await post('fresh', 'claim-signup')).body.granted, true);
    process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
