/**
 * Onboarding + first paywall only for users created at/after RELEASE_AT,
 * decided server-side; existing users never see them. The paywall depends on
 * the server entitlement, never on the client-writable onboarding flag.
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
const writes = [];
let playAnswer = null; // what the stubbed Play verification returns
let playCalls = 0;
const stubs = {
  '../utils/firestoreAdmin': {
    getAdmin: () => ({ auth: () => ({ getUser: async (uid) => ({ metadata: { creationTime: new Date(users[uid].created).toUTCString() } }) }) }),
    getDb: () => ({
      collection: () => ({
        doc: (uid) => ({
          get: async () => ({ exists: !!users[uid].doc, data: () => users[uid].doc }),
          set: async (d) => { writes.push({ uid, d }); users[uid].doc = { ...(users[uid].doc || {}), ...d }; },
        }),
      }),
    }),
  },
  './purchaseGrant': { verifyPurchase: async () => { playCalls++; return playAnswer; } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const svc = require('../services/onboardingStatus');

function reset() {
  Object.assign(users, {
    oldie: { created: '2026-09-01T10:00:00Z', doc: { credits: 5, subscription: receipt } },
    fresh: { created: NEW, doc: null },
    skipper: { created: NEW, doc: { profile: { niche: 'food', onboardingCompletedAt: 123 } } },
    payer: { created: NEW, doc: { profile: { onboardingCompletedAt: 1 }, entitlement: { active: true, expiresAt: future() } } },
    lapsed: { created: NEW, doc: { entitlement: { active: true, expiresAt: past() }, subscription: receipt } },
  });
  writes.length = 0;
  playCalls = 0;
  playAnswer = null;
  process.env.RELEASE_AT = '2026-10-07T00:00:00Z';
}

(async () => {
  console.log('Onboarding status tests\n');

  await t('user created before RELEASE_AT → nothing shown, no Play call', async () => {
    reset();
    assert.deepStrictEqual(await svc.getStatus('oldie'), { newUser: false, showOnboarding: false, showPaywall: false, entitlementExpiresAt: null });
    assert.strictEqual(playCalls, 0);
  });
  await t('new user without a profile → onboarding + paywall', async () => {
    reset();
    assert.deepStrictEqual(await svc.getStatus('fresh'), { newUser: true, showOnboarding: true, showPaywall: true, entitlementExpiresAt: null });
  });
  await t('client sets onboardingCompletedAt → onboarding skipped, paywall STILL shown', async () => {
    reset();
    assert.deepStrictEqual(await svc.getStatus('skipper'), { newUser: true, showOnboarding: false, showPaywall: true, entitlementExpiresAt: null });
  });
  await t('new user with an active entitlement → no paywall', async () => {
    reset();
    const s = await svc.getStatus('payer');
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(s.entitlementExpiresAt, users.payer.doc.entitlement.expiresAt.getTime());
    assert.strictEqual(playCalls, 0);
  });
  await t('expired entitlement, Play says renewed → refreshed, no paywall', async () => {
    reset();
    playAnswer = { status: 'valid', reason: 'SUBSCRIPTION_STATE_ACTIVE', expiryMillis: Date.now() + 30 * 86400000 };
    const s = await svc.getStatus('lapsed');
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(s.entitlementExpiresAt, playAnswer.expiryMillis);
    assert.strictEqual(users.lapsed.doc.entitlement.active, true);
  });
  await t('expired entitlement, Play says expired → paywall, entitlement marked inactive', async () => {
    reset();
    playAnswer = { status: 'invalid', reason: 'subscriptionState=SUBSCRIPTION_STATE_EXPIRED', expiryMillis: Date.now() - 1000 };
    assert.strictEqual((await svc.getStatus('lapsed')).showPaywall, true);
    assert.strictEqual(users.lapsed.doc.entitlement.active, false);
  });
  await t('Play outage → a previously verified payer is not locked out', async () => {
    reset();
    playAnswer = { status: 'unavailable', reason: 'play_503' };
    const s = await svc.getStatus('lapsed');
    assert.strictEqual(s.showPaywall, false);
    assert.strictEqual(s.entitlementExpiresAt, null); // unknown expiry → app must not cache it
    assert.strictEqual(writes.length, 0);
  });
  await t('RELEASE_AT unset or invalid → nobody is new', async () => {
    for (const v of [undefined, '', 'not-a-date']) {
      reset();
      if (v === undefined) delete process.env.RELEASE_AT; else process.env.RELEASE_AT = v;
      const s = await svc.getStatus('fresh');
      assert.strictEqual(s.showOnboarding, false);
      assert.strictEqual(s.showPaywall, false);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
