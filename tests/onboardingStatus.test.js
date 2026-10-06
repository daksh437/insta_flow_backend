/**
 * Onboarding + hard paywall only for the hard-paywall cohort: created at/after
 * RELEASE_AT (or allowlisted test uid) AND on the new app version; decided
 * server-side. Existing users and old app versions never see them. The hard gate depends
 * on the server entitlement (never-paid + not active), never on the
 * client-writable onboarding flag.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const NEW = '2026-10-07T10:00:00Z';
const future = () => new Date(Date.now() + 86400000);
const past = () => new Date(Date.now() - 86400000);
const receipt = { productId: 'instaflow_starter_299', purchaseToken: 'tok-1', verified: true };

const users = {};
let syncAnswer = null; // what the stubbed Play sync returns
let syncCalls = 0;
const stubs = {
  '../utils/firestoreAdmin': {
    getAdmin: () => ({ auth: () => ({ getUser: async (uid) => ({ metadata: { creationTime: new Date(users[uid].created).toUTCString() } }) }) }),
    getDb: () => ({
      collection: () => ({
        doc: (uid) => ({
          get: async () => ({ exists: !!users[uid].doc, data: () => users[uid].doc }),
          set: async (d) => {
            const cur = users[uid].doc || {};
            users[uid].doc = { ...cur, ...d, entitlement: { ...(cur.entitlement || {}), ...(d.entitlement || {}) } };
          },
        }),
      }),
    }),
  },
  './subscriptionSync': { syncSubscription: async () => { syncCalls++; return syncAnswer; } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const svc = require('../services/onboardingStatus');
const cohort = require('../services/cohort');

function reset() {
  Object.assign(users, {
    oldie: { created: '2026-09-01T10:00:00Z', doc: { credits: 5, subscription: receipt } },
    fresh: { created: NEW, doc: null },
    skipper: { created: NEW, doc: { profile: { niche: 'food', onboardingCompletedAt: 123 } } },
    payer: { created: NEW, doc: { profile: { onboardingCompletedAt: 1 }, entitlement: { active: true, everPaid: true, expiresAt: future() } } },
    lapsed: { created: NEW, doc: { entitlement: { active: true, everPaid: true, expiresAt: past() }, subscription: receipt } },
    comp: { created: NEW, doc: { entitlement: { active: true, source: 'admin_comp', expiresAt: future() } } },
  });
  cohort._cache.clear();
  syncCalls = 0;
  syncAnswer = null;
  process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
  process.env.HARD_PAYWALL_MIN_VERSION_CODE = '51';
  delete process.env.TEST_NEW_USER_UIDS;
}
const NEW_APP = { versionCode: 51 };

(async () => {
  console.log('Onboarding status tests\n');

  await t('user created before RELEASE_AT → nothing shown, no Play call', async () => {
    reset();
    const s = await svc.getStatus('oldie', NEW_APP);
    assert.strictEqual(s.newUser, false);
    assert.strictEqual(s.showOnboarding, false);
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(syncCalls, 0);
  });
  await t('new user without a profile → onboarding + hard paywall', async () => {
    reset();
    const s = await svc.getStatus('fresh', NEW_APP);
    assert.deepStrictEqual([s.newUser, s.showOnboarding, s.showPaywall, s.entitled, s.everPaid], [true, true, true, false, false]);
  });
  await t('client sets onboardingCompletedAt → onboarding skipped, hard paywall STILL shown', async () => {
    reset();
    const s = await svc.getStatus('skipper', NEW_APP);
    assert.strictEqual(s.showOnboarding, false);
    assert.strictEqual(s.showPaywall, true);
  });
  await t('new user with an active entitlement → no paywall, expiry returned', async () => {
    reset();
    const s = await svc.getStatus('payer', NEW_APP);
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(s.entitled, true);
    assert.strictEqual(s.entitlementExpiresAt, users.payer.doc.entitlement.expiresAt.getTime());
    assert.strictEqual(syncCalls, 0);
  });
  await t('expired entitlement, Play says renewed → active again', async () => {
    reset();
    const exp = Date.now() + 30 * 86400000;
    syncAnswer = { status: 'synced', entitlement: { active: true, expiresAtMillis: exp } };
    const s = await svc.getStatus('lapsed', NEW_APP);
    assert.strictEqual(s.entitled, true);
    assert.strictEqual(s.entitlementExpiresAt, exp);
  });
  await t('trial/subscription ended (paid before) → NOT hard-gated, not entitled', async () => {
    reset();
    syncAnswer = { status: 'synced', entitlement: { active: false, expiresAtMillis: Date.now() - 1000 } };
    const s = await svc.getStatus('lapsed', NEW_APP);
    assert.strictEqual(s.entitled, false);
    assert.strictEqual(s.everPaid, true);
    assert.strictEqual(s.showPaywall, false);
  });
  await t('Play outage → a previously verified payer keeps access', async () => {
    reset();
    syncAnswer = { status: 'unavailable', reason: 'play_503' };
    const s = await svc.getStatus('lapsed', NEW_APP);
    assert.strictEqual(s.entitled, true);
    assert.strictEqual(s.entitlementExpiresAt, null); // unknown expiry → app must not cache it
  });
  await t('admin comp entitlement (review account) → no paywall', async () => {
    reset();
    const s = await svc.getStatus('comp', NEW_APP);
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(s.entitled, true);
  });
  await t('new account on the OLD app (no version header) → legacy, nothing shown', async () => {
    reset();
    const s = await svc.getStatus('fresh');
    assert.deepStrictEqual([s.newUser, s.showOnboarding, s.showPaywall], [false, false, false]);
    const s2 = await svc.getStatus('fresh', { versionCode: 50 });
    assert.strictEqual(s2.newUser, false);
  });
  await t('first call from the new app stores the cohort; later calls without a version agree', async () => {
    reset();
    await svc.getStatus('fresh', NEW_APP);
    assert.strictEqual(users.fresh.doc.entitlement.cohort, 'hard');
    const s = await svc.getStatus('fresh');
    assert.strictEqual(s.showPaywall, true);
  });
  await t('HARD_PAYWALL_MIN_VERSION_CODE unset → nobody is in the cohort', async () => {
    reset();
    delete process.env.HARD_PAYWALL_MIN_VERSION_CODE;
    assert.strictEqual((await svc.getStatus('fresh', NEW_APP)).newUser, false);
  });
  await t('TEST_NEW_USER_UIDS: an old account behaves as new before RELEASE_AT is set', async () => {
    reset();
    delete process.env.RELEASE_AT;
    process.env.TEST_NEW_USER_UIDS = 'someone, oldie';
    syncAnswer = { status: 'invalid', reason: 'expired' }; // its old receipt is no longer active
    const s = await svc.getStatus('oldie', NEW_APP);
    assert.strictEqual(s.newUser, true);
    assert.strictEqual(s.showOnboarding, true);
    assert.strictEqual((await svc.getStatus('fresh', NEW_APP)).newUser, false); // not allowlisted
  });
  await t('RELEASE_AT unset or invalid → nobody is new', async () => {
    for (const v of [undefined, '', 'not-a-date']) {
      reset();
      if (v === undefined) delete process.env.RELEASE_AT; else process.env.RELEASE_AT = v;
      const s = await svc.getStatus('fresh', NEW_APP);
      assert.strictEqual(s.showOnboarding, false);
      assert.strictEqual(s.showPaywall, false);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
