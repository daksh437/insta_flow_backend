/**
 * ₹5 trial → conversion → renewals, via client activation and RTDN:
 * credits once per Play order, entitlement state, trial reminder schedule,
 * ownership, upgrades and refunds.
 */
const assert = require('assert');
const Module = require('module');
const crypto = require('crypto');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); fail++; }
}

const { db, store, FieldValue } = createFakeFirestore();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// fake Play: token → subscriptionsv2 payload (or Error)
const play = {};
const api = {
  purchases: {
    subscriptionsv2: {
      get: async ({ token }) => {
        const v = play[token];
        if (v instanceof Error) throw v;
        if (!v) throw Object.assign(new Error('not found'), { response: { status: 404, data: { error: { message: 'not found' } } } });
        return { data: v };
      },
    },
    products: { get: async () => { throw new Error('unused'); } },
  },
};
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: { message: `status ${status}` } } } });

const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db, getAdmin: () => ({ auth: () => ({ getUser: async () => ({ metadata: { creationTime: new Date('2026-09-01').toUTCString() } }) }) }) },
  '../utils/playVerify': { getPublisherApi: () => api, PACKAGE_NAME: 'com.instaflow' },
  'firebase-admin': { firestore: { FieldValue } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const sync = require('../services/subscriptionSync');
const { verifyAndGrant } = require('../services/purchaseGrant');
console.log = quiet;

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const user = (uid) => store.get(`users/${uid}`) || {};
const ent = (uid) => user(uid).entitlement || {};
const credits = (uid) => user(uid).credits || 0;
const ledger = (uid) => [...store.entries()].filter(([k]) => k.startsWith(`users/${uid}/credit_transactions/`)).map(([, v]) => v);

/** subscriptionsv2 payload for one Starter line item. */
function sub({ uid = 'u1', state = 'SUBSCRIPTION_STATE_ACTIVE', orderId = 'GPA.1', trial = true, phase, expiresIn = 3 * DAY, autoRenew = true, productId = 'instaflow_starter_299', linked } = {}) {
  return {
    subscriptionState: state,
    latestOrderId: orderId,
    linkedPurchaseToken: linked,
    externalAccountIdentifiers: uid ? { obfuscatedExternalAccountId: uid } : undefined,
    lineItems: [{
      productId,
      expiryTime: iso(Date.now() + expiresIn),
      latestSuccessfulOrderId: orderId,
      offerDetails: { basePlanId: 'starter', offerId: trial ? 'trial-3days' : undefined },
      offerPhase: phase || (trial ? { introductoryPrice: {} } : { basePrice: {} }),
      autoRenewingPlan: { autoRenewEnabled: autoRenew, recurringPrice: { currencyCode: 'INR', units: '300' } },
    }],
  };
}

(async () => {
  console.log('Subscription sync tests\n');
  store.set('users/u1', { credits: 0 });

  await t('₹5 trial verified via the app → +100 once, trial entitlement, reminder scheduled', async () => {
    play.tokA = sub();
    const r = await verifyAndGrant({ uid: 'u1', productId: 'instaflow_starter_299', purchaseToken: 'tokA' });
    assert.strictEqual(r.status, 'granted');
    assert.strictEqual(r.isTrial, true);
    assert.strictEqual(r.orderId, 'GPA.1');
    assert.strictEqual(credits('u1'), 100);
    const e = ent('u1');
    assert.deepStrictEqual([e.active, e.isTrial, e.everPaid, e.trialUsed, e.autoRenewing], [true, true, true, true, true]);
    assert.deepStrictEqual(e.renewalPrice, { currencyCode: 'INR', units: '300', nanos: 0 });
    const rem = store.get('trial_reminders/u1');
    assert.ok(rem, 'reminder scheduled');
    assert.strictEqual(rem.dueAt.getTime(), e.expiresAt.getTime() - DAY);
    assert.strictEqual(ledger('u1')[0].type, 'trial');
  });

  await t('app retries + RTDN PURCHASED for the same order → still +100 only', async () => {
    const again = await verifyAndGrant({ uid: 'u1', productId: 'instaflow_starter_299', purchaseToken: 'tokA' });
    assert.strictEqual(again.status, 'already_granted');
    const r = await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    assert.strictEqual(r.status, 'synced');
    assert.strictEqual(r.granted, false);
    assert.strictEqual(credits('u1'), 100);
  });

  await t('spend 30, then trial converts (RENEWED, order ..0) → +1000 on top of the leftover 70', async () => {
    store.set('users/u1', { ...user('u1'), credits: 70 });
    play.tokA = sub({ orderId: 'GPA.1..0', trial: true, phase: { basePrice: {} }, expiresIn: 30 * DAY });
    const r = await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    assert.strictEqual(r.granted, true);
    assert.strictEqual(r.isTrial, false);
    assert.strictEqual(credits('u1'), 1070);
    assert.strictEqual(ent('u1').isTrial, false);
    assert.strictEqual(store.get('trial_reminders/u1'), undefined, 'reminder cleared after conversion');
  });

  await t('next renewal (..1) → +1000; duplicate notification → no change', async () => {
    play.tokA = sub({ orderId: 'GPA.1..1', trial: true, phase: { basePrice: {} }, expiresIn: 30 * DAY });
    await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    assert.strictEqual(credits('u1'), 2070);
  });

  await t('CANCELED (auto-renew off) → access until expiry, no new credits', async () => {
    play.tokA = sub({ state: 'SUBSCRIPTION_STATE_CANCELED', orderId: 'GPA.1..1', trial: true, phase: { basePrice: {} }, expiresIn: 10 * DAY, autoRenew: false });
    await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    assert.strictEqual(ent('u1').active, true);
    assert.strictEqual(ent('u1').autoRenewing, false);
    assert.strictEqual(credits('u1'), 2070);
  });

  await t('EXPIRED → not active, everPaid stays true (no hard gate), credits kept', async () => {
    play.tokA = sub({ state: 'SUBSCRIPTION_STATE_EXPIRED', orderId: 'GPA.1..1', trial: true, phase: { basePrice: {} }, expiresIn: -DAY, autoRenew: false });
    await sync.syncSubscription({ purchaseToken: 'tokA', productId: 'instaflow_starter_299' });
    assert.strictEqual(ent('u1').active, false);
    assert.strictEqual(ent('u1').everPaid, true);
    assert.strictEqual(credits('u1'), 2070);
  });

  await t('ON_HOLD (payment failed) → not active, nothing granted', async () => {
    store.set('users/u2', { credits: 0 });
    play.tokB = sub({ uid: 'u2', state: 'SUBSCRIPTION_STATE_ON_HOLD', orderId: 'GPA.2' });
    const r = await verifyAndGrant({ uid: 'u2', productId: 'instaflow_starter_299', purchaseToken: 'tokB' });
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(credits('u2'), 0);
    assert.strictEqual(ent('u2').active, false);
    assert.notStrictEqual(ent('u2').everPaid, true);
  });

  await t('first order granted by the old token-keyed code → not granted again', async () => {
    store.set('users/u3', { credits: 1000 });
    store.set(`credit_grants/${sha('tokC:instaflow_starter_299')}`, { uid: 'u3', productId: 'instaflow_starter_299', amount: 1000, orderId: 'GPA.3' });
    play.tokC = sub({ uid: 'u3', orderId: 'GPA.3', trial: false, expiresIn: 30 * DAY });
    const r = await verifyAndGrant({ uid: 'u3', productId: 'instaflow_starter_299', purchaseToken: 'tokC' });
    assert.strictEqual(r.status, 'already_granted');
    assert.strictEqual(credits('u3'), 1000);
  });

  await t('Pro bought without the trial offer → 2000, not a trial', async () => {
    store.set('users/u4', { credits: 0 });
    play.tokD = sub({ uid: 'u4', orderId: 'GPA.4', trial: false, productId: 'instaflow_pro_599', expiresIn: 30 * DAY });
    const r = await verifyAndGrant({ uid: 'u4', productId: 'instaflow_pro_599', purchaseToken: 'tokD' });
    assert.strictEqual(r.isTrial, false);
    assert.strictEqual(credits('u4'), 2000);
  });

  await t('RTDN without obfuscated id → owner from the first-claim record', async () => {
    store.set('users/u5', { credits: 0 });
    store.set(`purchase_tokens/${sha('tokE')}`, { uid: 'u5' });
    play.tokE = sub({ uid: null, orderId: 'GPA.5', trial: false, expiresIn: 30 * DAY });
    const r = await sync.syncSubscription({ purchaseToken: 'tokE', productId: 'instaflow_starter_299' });
    assert.strictEqual(r.uid, 'u5');
    assert.strictEqual(credits('u5'), 1000);
  });

  await t('upgrade (new token, linkedPurchaseToken) → same owner, Pro credits', async () => {
    play.tokF = sub({ uid: null, orderId: 'GPA.6', trial: false, productId: 'instaflow_pro_599', linked: 'tokE', expiresIn: 30 * DAY });
    const r = await sync.syncSubscription({ purchaseToken: 'tokF', productId: 'instaflow_pro_599' });
    assert.strictEqual(r.uid, 'u5');
    assert.strictEqual(credits('u5'), 3000);
    assert.strictEqual(ent('u5').productId, 'instaflow_pro_599');
  });

  await t('RTDN for a token nobody claimed yet → unowned, nothing granted', async () => {
    play.tokG = sub({ uid: null, orderId: 'GPA.7' });
    const r = await sync.syncSubscription({ purchaseToken: 'tokG', productId: 'instaflow_starter_299' });
    assert.strictEqual(r.status, 'unowned');
  });

  await t("another account's purchase presented by the app → invalid, nothing granted", async () => {
    store.set('users/eve', { credits: 0 });
    play.tokH = sub({ uid: 'u9', orderId: 'GPA.8' });
    const r = await verifyAndGrant({ uid: 'eve', productId: 'instaflow_starter_299', purchaseToken: 'tokH' });
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(credits('eve'), 0);
  });

  await t('Play outage → unavailable/pending, nothing granted', async () => {
    store.set('users/u6', { credits: 0 });
    play.tokI = httpErr(503);
    const r = await verifyAndGrant({ uid: 'u6', productId: 'instaflow_starter_299', purchaseToken: 'tokI' });
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(credits('u6'), 0);
  });

  await t('trial refunded (only paid order) → 100 clawed back (floor 0), user is never-paid again', async () => {
    store.set('users/u7', { credits: 0 });
    play.tokJ = sub({ uid: 'u7', orderId: 'GPA.9' });
    await verifyAndGrant({ uid: 'u7', productId: 'instaflow_starter_299', purchaseToken: 'tokJ' });
    store.set('users/u7', { ...user('u7'), credits: 40 }); // spent 60 already
    play.tokJ = sub({ uid: 'u7', state: 'SUBSCRIPTION_STATE_EXPIRED', orderId: 'GPA.9', expiresIn: -1000 });
    const r = await sync.handleVoided({ purchaseToken: 'tokJ', orderId: 'GPA.9' });
    assert.strictEqual(r.status, 'clawed_back');
    assert.strictEqual(r.amount, 40);
    assert.strictEqual(credits('u7'), 0);
    assert.strictEqual(ent('u7').everPaid, false);
    assert.strictEqual(ent('u7').active, false);
    const last = ledger('u7').find((l) => l.type === 'refund_clawback');
    assert.strictEqual(last.amount, -40);
  });

  await t('same refund notification again → no second clawback', async () => {
    store.set('users/u7', { ...user('u7'), credits: 25 });
    const r = await sync.handleVoided({ purchaseToken: 'tokJ', orderId: 'GPA.9' });
    assert.strictEqual(r.status, 'duplicate');
    assert.strictEqual(credits('u7'), 25);
  });

  await t('referrer in the hard-paywall cohort → no purchase bonus; legacy referrer still gets it', async () => {
    process.env.TEST_NEW_USER_UIDS = 'refHard';
    process.env.HARD_PAYWALL_MIN_VERSION_CODE = '51';
    store.set('users/refHard', { credits: 0, entitlement: { cohort: 'hard' } });
    store.set('users/refOld', { credits: 0 });
    store.set('users/u10', { credits: 0, referredByUid: 'refHard' });
    store.set('users/u11', { credits: 0, referredByUid: 'refOld' });
    play.tokK = sub({ uid: 'u10', orderId: 'GPA.10', trial: false, expiresIn: 30 * DAY });
    play.tokL = sub({ uid: 'u11', orderId: 'GPA.11', trial: false, expiresIn: 30 * DAY });
    await verifyAndGrant({ uid: 'u10', productId: 'instaflow_starter_299', purchaseToken: 'tokK' });
    await verifyAndGrant({ uid: 'u11', productId: 'instaflow_starter_299', purchaseToken: 'tokL' });
    assert.strictEqual(credits('refHard'), 0);
    assert.strictEqual(credits('refOld'), 100); // 10% of 1000
    delete process.env.TEST_NEW_USER_UIDS;
    delete process.env.HARD_PAYWALL_MIN_VERSION_CODE;
  });

  await t('renewal refunded while the trial stands → that order clawed back, everPaid stays true', async () => {
    const before = credits('u1');
    const r = await sync.handleVoided({ purchaseToken: 'tokA', orderId: 'GPA.1..1' });
    assert.strictEqual(r.status, 'clawed_back');
    assert.strictEqual(credits('u1'), before - 1000);
    assert.strictEqual(ent('u1').everPaid, true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
