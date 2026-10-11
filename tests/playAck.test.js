/**
 * PENDING purchases (UPI, cash): nothing is granted while Play says pending;
 * when the payment completes the RTDN alone (app closed) grants the trial and
 * opens access, and the server acknowledges the purchase if the app hasn't
 * within 15 minutes, so Google does not refund it after 3 days.
 */
const assert = require('assert');
const Module = require('module');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    ')); fail++; }
}

const { db, store, FieldValue } = createFakeFirestore();
const play = {};
const acks = [];
let ackError = null;
const api = {
  purchases: {
    subscriptionsv2: {
      get: async ({ token }) => {
        if (!play[token]) throw Object.assign(new Error('not found'), { response: { status: 404, data: { error: { message: 'not found' } } } });
        return { data: play[token] };
      },
    },
    subscriptions: {
      acknowledge: async (args) => {
        if (ackError) throw ackError;
        acks.push(args);
        play[args.token] = { ...play[args.token], acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
      },
    },
    products: { get: async () => { throw new Error('unused'); } },
  },
};
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
const playAck = require('../services/playAck');
console.log = quiet;

const DAY = 86400000;
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const user = (uid) => store.get(`users/${uid}`) || {};
const ackDocs = () => [...store.keys()].filter((k) => k.startsWith(`${playAck.COLLECTION}/`));

function sub({ uid = 'u1', state, ack = 'ACKNOWLEDGEMENT_STATE_PENDING', orderId = 'GPA.9' }) {
  return {
    subscriptionState: state,
    acknowledgementState: ack,
    latestOrderId: orderId,
    externalAccountIdentifiers: { obfuscatedExternalAccountId: uid },
    lineItems: [{
      productId: 'instaflow_starter_299',
      expiryTime: iso(Date.now() + 3 * DAY),
      latestSuccessfulOrderId: state === 'SUBSCRIPTION_STATE_PENDING' ? undefined : orderId,
      offerDetails: { basePlanId: 'starter', offerId: 'trial-3days' },
      offerPhase: { introductoryPrice: {} },
      autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'INR', units: '300' } },
    }],
  };
}

(async () => {
  console.log('Pending purchases + server acknowledgement\n');
  store.set('users/u1', { credits: 0, entitlement: { cohort: 'hard' } });

  await t('PENDING (UPI not paid yet) → nothing granted, no access, nothing to acknowledge', async () => {
    play.tok = sub({ state: 'SUBSCRIPTION_STATE_PENDING' });
    const r = await sync.syncSubscription({ purchaseToken: 'tok', productId: 'instaflow_starter_299' });
    assert.strictEqual(r.status, 'synced');
    assert.strictEqual(r.paid, false);
    assert.strictEqual(user('u1').credits, 0);
    assert.notStrictEqual(user('u1').entitlement.active, true);
    assert.deepStrictEqual(ackDocs(), []);
  });

  await t('payment completes while the app is closed: RTDN alone grants +100 and opens access', async () => {
    play.tok = sub({ state: 'SUBSCRIPTION_STATE_ACTIVE' });
    const r = await sync.syncSubscription({ purchaseToken: 'tok', productId: 'instaflow_starter_299' }); // RTDN: no uid hint
    assert.strictEqual(r.uid, 'u1');
    assert.strictEqual(r.granted, true);
    assert.strictEqual(user('u1').credits, 100);
    assert.strictEqual(user('u1').entitlement.active, true);
    assert.strictEqual(user('u1').entitlement.isTrial, true);
    assert.strictEqual(ackDocs().length, 1, 'unacknowledged purchase recorded');
  });

  await t('the app gets 15 minutes to acknowledge first; then the server does it once', async () => {
    const seen = store.get(ackDocs()[0]).firstSeenAt.getTime();
    let r = await playAck.sweepUnacknowledged(new Date(seen + 10 * MIN));
    assert.strictEqual(r.acknowledged, 0);
    assert.strictEqual(acks.length, 0);
    r = await playAck.sweepUnacknowledged(new Date(seen + 16 * MIN));
    assert.strictEqual(r.acknowledged, 1);
    assert.deepStrictEqual(
      { packageName: acks[0].packageName, subscriptionId: acks[0].subscriptionId, token: acks[0].token },
      { packageName: 'com.instaflow', subscriptionId: 'instaflow_starter_299', token: 'tok' });
    assert.deepStrictEqual(ackDocs(), []);
    r = await playAck.sweepUnacknowledged(new Date(seen + 30 * MIN));
    assert.strictEqual(acks.length, 1, 'never acknowledged twice');
  });

  await t('the app acknowledged in time → the record is dropped, no server call', async () => {
    play.tok2 = sub({ state: 'SUBSCRIPTION_STATE_ACTIVE', orderId: 'GPA.10' });
    store.set('users/u1', { ...user('u1') });
    await sync.syncSubscription({ purchaseToken: 'tok2', productId: 'instaflow_starter_299' });
    assert.strictEqual(ackDocs().length, 1);
    play.tok2.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    const r = await playAck.sweepUnacknowledged(new Date(Date.now() + 20 * MIN));
    assert.strictEqual(r.alreadyDone, 1);
    assert.strictEqual(acks.length, 1);
    assert.deepStrictEqual(ackDocs(), []);
  });

  await t('a later sync of an acknowledged purchase clears any stale record', async () => {
    play.tok3 = sub({ state: 'SUBSCRIPTION_STATE_ACTIVE', orderId: 'GPA.11' });
    await sync.syncSubscription({ purchaseToken: 'tok3', productId: 'instaflow_starter_299' });
    assert.strictEqual(ackDocs().length, 1);
    play.tok3.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    await sync.syncSubscription({ purchaseToken: 'tok3', productId: 'instaflow_starter_299' });
    assert.deepStrictEqual(ackDocs(), []);
  });

  await t('no longer paid (expired) → dropped without acknowledging; Play error → kept for retry', async () => {
    play.tok4 = sub({ state: 'SUBSCRIPTION_STATE_ACTIVE', orderId: 'GPA.12' });
    await sync.syncSubscription({ purchaseToken: 'tok4', productId: 'instaflow_starter_299' });
    play.tok4.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    let r = await playAck.sweepUnacknowledged(new Date(Date.now() + 20 * MIN));
    assert.strictEqual(r.dropped, 1);
    assert.strictEqual(acks.length, 1);

    play.tok5 = sub({ state: 'SUBSCRIPTION_STATE_ACTIVE', orderId: 'GPA.13' });
    await sync.syncSubscription({ purchaseToken: 'tok5', productId: 'instaflow_starter_299' });
    ackError = new Error('backend error');
    r = await playAck.sweepUnacknowledged(new Date(Date.now() + 20 * MIN));
    assert.strictEqual(r.errors, 1);
    assert.strictEqual(ackDocs().length, 1, 'kept for the next sweep');
    ackError = null;
    r = await playAck.sweepUnacknowledged(new Date(Date.now() + 30 * MIN));
    assert.strictEqual(r.acknowledged, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
