/**
 * The referral "friend tried AI" reward (FREE_GRANTS.REFERRAL_INVITER) is a
 * free-credit grant: never paid when either side is a new user (after
 * RELEASE_AT). Existing referrer + existing friend still earn it.
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
const created = {
  oldRef: '2026-09-01T00:00:00Z', oldFriend: '2026-09-02T00:00:00Z',
  newFriend: '2026-10-08T00:00:00Z', newRef: '2026-10-08T00:00:00Z', friendOfNew: '2026-09-03T00:00:00Z',
};
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
process.env.HARD_PAYWALL_MIN_VERSION_CODE = '51';
const HARD = { cohort: 'hard' }; // stored by the server when seen on the new app
process.env.CREDITS_ENABLED = 'true';
const quiet = console.log; console.log = () => {}; console.warn = () => {};
const { recordAiUsage } = require('../middleware/aiAccess');
console.log = quiet;

const credits = (uid) => (store.get(`users/${uid}`) || {}).credits || 0;

(async () => {
  console.log('Referral reward vs new users\n');
  store.set('users/oldRef', { credits: 0 });
  store.set('users/newRef', { credits: 0, entitlement: HARD });

  await t('existing referrer + existing friend → referrer still earns the reward', async () => {
    store.set('users/oldFriend', { credits: 10, referredByUid: 'oldRef' });
    await recordAiUsage('oldFriend', 'r1', 'k1', { endpoint: '/ai/generate-captions' });
    assert.strictEqual(credits('oldRef'), 50);
  });

  await t('hard-paywall friend → no reward for the referrer', async () => {
    store.set('users/newFriend', { credits: 100, referredByUid: 'oldRef', entitlement: HARD });
    await recordAiUsage('newFriend', 'r2', 'k2', { endpoint: '/ai/generate-captions' });
    assert.strictEqual(credits('oldRef'), 50);
  });

  await t('new friend still on the old app (no cohort) → legacy reward paid', async () => {
    created.oldAppFriend = '2026-10-08T00:00:00Z';
    store.set('users/oldAppFriend', { credits: 10, referredByUid: 'oldRef' });
    await recordAiUsage('oldAppFriend', 'r4', 'k4', { endpoint: '/ai/generate-captions' });
    assert.strictEqual(credits('oldRef'), 100);
  });

  await t('hard-paywall referrer → no reward even for an existing friend', async () => {
    store.set('users/friendOfNew', { credits: 10, referredByUid: 'newRef' });
    await recordAiUsage('friendOfNew', 'r3', 'k3', { endpoint: '/ai/generate-captions' });
    assert.strictEqual(credits('newRef'), 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
