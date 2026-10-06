/**
 * The cohort is decided by an account's FIRST app session and kept for good:
 * first seen on build 48 (or already given the legacy 3-day trial label) →
 * 'legacy' forever, even after updating; first seen on the new app → 'hard'.
 * The legacy trial label (display-only with credits on) keeps being stamped
 * for everyone outside the hard cohort.
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
const NEW = '2026-10-08T00:00:00Z';
const created = { existing: '2026-09-01T00:00:00Z', oldApp: NEW, newApp: NEW, stamped: NEW, bg: NEW };
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
const cohort = require('../services/cohort');
const OLD_APP = { fromClient: true }; // build 48: no X-App-Version-Code
const NEW_APP = { fromClient: true, versionCode: 51 };
console.log = quiet;

const doc = (uid) => store.get(`users/${uid}`);

(async () => {
  console.log('Legacy trial vs hard-paywall cohort\n');
  for (const uid of Object.keys(created)) store.set(`users/${uid}`, { email: `${uid}@x.com` });

  await t('existing account (new app) → legacy trial stamped, as before', async () => {
    const a = await getAiAccess('existing', NEW_APP);
    assert.strictEqual(doc('existing').planType, 'trial');
    assert.ok(doc('existing').trialEndDate instanceof Date);
    assert.strictEqual(a.planType, 'trial');
  });

  await t('new account, first session on build 48 → legacy cohort + legacy trial label', async () => {
    await getAiAccess('oldApp', OLD_APP);
    assert.strictEqual(doc('oldApp').entitlement.cohort, 'legacy');
    assert.strictEqual(doc('oldApp').planType, 'trial');
    assert.ok(doc('oldApp').trialEndDate instanceof Date);
  });

  await t('...then updates to the new app → stays legacy for good (no hard paywall)', async () => {
    await getAiAccess('oldApp', NEW_APP);
    assert.strictEqual(await cohort.isHardPaywallUser('oldApp', NEW_APP), false);
    assert.strictEqual(doc('oldApp').entitlement.cohort, 'legacy');
  });

  await t('legacy trial label already stamped (no cohort yet) → legacy even on the new app', async () => {
    store.set('users/stamped', { planType: 'trial', trialStartDate: new Date(), trialEndDate: new Date() });
    assert.strictEqual(await cohort.isHardPaywallUser('stamped', NEW_APP), false);
    assert.strictEqual(doc('stamped').entitlement.cohort, 'legacy');
  });

  await t('background checks (no app request) never decide the cohort', async () => {
    assert.strictEqual(await cohort.isHardPaywallUser('bg'), false);
    assert.strictEqual(doc('bg').entitlement, undefined);
  });

  await t('new account on the new app → no trial dates, planType free, cohort stored', async () => {
    const a = await getAiAccess('newApp', NEW_APP);
    assert.strictEqual(doc('newApp').planType, 'free');
    assert.strictEqual(doc('newApp').trialEndDate, undefined);
    assert.strictEqual(doc('newApp').entitlement.cohort, 'hard');
    assert.strictEqual(a.planType, 'free');
  });

  await t('...and an old app later cannot pull a hard-cohort account back to legacy', async () => {
    assert.strictEqual(await cohort.isHardPaywallUser('newApp', OLD_APP), true);
    assert.strictEqual(doc('newApp').entitlement.cohort, 'hard');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
