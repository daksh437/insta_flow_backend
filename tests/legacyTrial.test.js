/**
 * The legacy 3-day "trial" label (display-only with credits on) keeps being
 * stamped for everyone outside the hard-paywall cohort — existing users and
 * new signups on build 48 see no change. Only hard-paywall users (new account
 * AND new app) get planType 'free' with no trial dates.
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
const created = { existing: '2026-09-01T00:00:00Z', oldApp: '2026-10-08T00:00:00Z', newApp: '2026-10-08T00:00:00Z' };
const stubs = {
  '../utils/firestoreAdmin': {
    getDb: () => db,
    getAdmin: () => ({
      firestore: { FieldValue },
      auth: () => ({ getUser: async (uid) => ({ metadata: { creationTime: new Date(created[uid]).toUTCString() } }) }),
    }),
  },
};
stubs['./firestoreAdmin'] = stubs['../utils/firestoreAdmin']; // utils/ensureUserAiFields
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
process.env.HARD_PAYWALL_MIN_VERSION_CODE = '51';
process.env.CREDITS_ENABLED = 'true';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const { getAiAccess } = require('../middleware/aiAccess');
console.log = quiet;

const doc = (uid) => store.get(`users/${uid}`);

(async () => {
  console.log('Legacy trial vs hard-paywall cohort\n');
  for (const uid of Object.keys(created)) store.set(`users/${uid}`, { email: `${uid}@x.com` });

  await t('existing account (new app) → legacy trial stamped, as before', async () => {
    const a = await getAiAccess('existing', { versionCode: 51 });
    assert.strictEqual(doc('existing').planType, 'trial');
    assert.ok(doc('existing').trialEndDate instanceof Date);
    assert.strictEqual(a.planType, 'trial');
  });

  await t('new account on build 48 (no version) → legacy trial stamped, no cohort', async () => {
    await getAiAccess('oldApp');
    assert.strictEqual(doc('oldApp').planType, 'trial');
    assert.ok(doc('oldApp').trialEndDate instanceof Date);
    assert.strictEqual((doc('oldApp').entitlement || {}).cohort, undefined);
  });

  await t('new account on the new app → no trial dates, planType free, cohort stored', async () => {
    const a = await getAiAccess('newApp', { versionCode: 51 });
    assert.strictEqual(doc('newApp').planType, 'free');
    assert.strictEqual(doc('newApp').trialEndDate, undefined);
    assert.strictEqual(doc('newApp').entitlement.cohort, 'hard');
    assert.strictEqual(a.planType, 'free');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
