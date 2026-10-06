/**
 * No credits without Google Play verification.
 * Play API and Firestore are faked in memory.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

// ── in-memory Firestore ──────────────────────────────────────────────────
const store = new Map(); // path -> data
const docRef = (path) => ({
  path,
  id: path.split('/').pop(),
  collection: (c) => collectionRef(`${path}/${c}`),
  get: async () => ({ exists: store.has(path), data: () => store.get(path), id: path.split('/').pop(), ref: docRef(path) }),
  set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...strip(data) } : strip(data)); },
  delete: async () => { store.delete(path); },
});
let autoId = 0;
const collectionRef = (path) => ({
  doc: (id) => docRef(`${path}/${id || `auto${++autoId}`}`),
  limit: () => ({ get: async () => ({ docs: [...store.keys()].filter((k) => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map((k) => ({ id: k.split('/').pop(), data: () => store.get(k), ref: docRef(k) })) }) }),
});
// FieldValue sentinels → plain values (good enough for these tests)
const strip = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = v && v.__inc !== undefined ? v.__inc : v && v.__ts ? new Date() : v;
  return out;
};
const db = {
  collection: collectionRef,
  runTransaction: async (fn) => fn({
    get: (ref) => ref.get(),
    set: (ref, data, opts) => { ref.set(data, opts); },
  }),
};

// ── fake Play API ────────────────────────────────────────────────────────
const play = { sub: null, product: null };
const api = {
  purchases: {
    subscriptionsv2: { get: async () => { if (play.sub instanceof Error) throw play.sub; return { data: play.sub }; } },
    products: { get: async () => { if (play.product instanceof Error) throw play.product; return { data: play.product }; } },
  },
};
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { error: { message: `status ${status}` } } } });

const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db },
  '../utils/playVerify': { getPublisherApi: () => api, PACKAGE_NAME: 'com.instaflow' },
  'firebase-admin': { firestore: { FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => ({ __inc: n }) } } },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.error = () => {}; console.warn = () => {};
const { verifyAndGrant, retryPendingVerifications } = require('../services/purchaseGrant');
console.log = quiet;

const credits = (uid) => (store.get(`users/${uid}`) || {}).credits || 0;
const pending = () => [...store.keys()].filter((k) => k.startsWith('pending_purchase_verifications/'));
const reset = () => { store.clear(); store.set('users/u1', { credits: 5 }); };
const activeSub = (over = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  lineItems: [{ productId: 'instaflow_starter_299', latestSuccessfulOrderId: 'GPA.1111-0' }],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: 'u1' },
  ...over,
});
const SUB = { uid: 'u1', productId: 'instaflow_starter_299', purchaseToken: 'tok-sub' };
const PACK = { uid: 'u1', productId: 'credits_79', purchaseToken: 'tok-pack' };

(async () => {
  console.log('Purchase grant tests\n');

  await t('verified active subscription → 1000 credits, ledger entry', async () => {
    reset(); play.sub = activeSub();
    const r = await verifyAndGrant(SUB);
    assert.strictEqual(r.status, 'granted');
    assert.strictEqual(credits('u1'), 1005);
    assert.ok([...store.keys()].some((k) => k.startsWith('users/u1/credit_transactions/')));
  });

  await t('verified subscription → server entitlement with Play expiry', async () => {
    reset();
    const expiry = new Date(Date.now() + 3 * 86400000);
    play.sub = activeSub({ lineItems: [{ productId: 'instaflow_starter_299', latestSuccessfulOrderId: 'GPA.2222-0', expiryTime: expiry.toISOString() }] });
    await verifyAndGrant({ ...SUB, purchaseToken: 'tok-ent' });
    const e = store.get('users/u1').entitlement;
    assert.strictEqual(e.active, true);
    assert.strictEqual(e.productId, 'instaflow_starter_299');
    assert.strictEqual(e.expiresAt.getTime(), expiry.getTime());
    reset(); play.sub = activeSub(); await verifyAndGrant(SUB); // restore state for the next test
  });

  await t('same purchase again → no second grant', async () => {
    const r = await verifyAndGrant(SUB);
    assert.strictEqual(r.status, 'already_granted');
    assert.strictEqual(credits('u1'), 1005);
  });

  await t('invalid token (Play 400) → nothing granted, nothing queued', async () => {
    reset(); play.sub = httpErr(400);
    const r = await verifyAndGrant(SUB);
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(credits('u1'), 5);
    assert.strictEqual(pending().length, 0);
  });

  await t('expired / on-hold subscription → nothing granted', async () => {
    for (const state of ['SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PENDING']) {
      reset(); play.sub = activeSub({ subscriptionState: state });
      assert.strictEqual((await verifyAndGrant(SUB)).status, 'invalid', state);
      assert.strictEqual(credits('u1'), 5);
    }
  });

  await t("someone else's purchase token → nothing granted", async () => {
    reset(); play.sub = activeSub({ externalAccountIdentifiers: { obfuscatedExternalAccountId: 'attacker' } });
    assert.strictEqual((await verifyAndGrant(SUB)).status, 'invalid');
    assert.strictEqual(credits('u1'), 5);
  });

  await t('no obfuscated id: first uid claims the token and gets the credits', async () => {
    reset(); store.set('users/u2', { credits: 0 });
    play.sub = activeSub({ externalAccountIdentifiers: undefined });
    assert.strictEqual((await verifyAndGrant(SUB)).status, 'granted');
    assert.strictEqual(credits('u1'), 1005);
    assert.ok([...store.values()].some((v) => v && v.uid === 'u1' && v.via === 'first_claim'));
  });

  await t('no obfuscated id: a second uid presenting the same token gets nothing', async () => {
    const r = await verifyAndGrant({ ...SUB, uid: 'u2' });
    assert.strictEqual(r.status, 'invalid');
    assert.strictEqual(credits('u2'), 0);
    assert.strictEqual(credits('u1'), 1005);
  });

  await t('obfuscated id present but token already claimed by someone else → nothing', async () => {
    reset();
    play.sub = activeSub({ externalAccountIdentifiers: undefined });
    store.set('users/u2', { credits: 0 });
    await verifyAndGrant({ ...SUB, uid: 'u2' }); // u2 claims first (no id)
    play.sub = activeSub(); // now Play reports obfuscated id u1
    assert.strictEqual((await verifyAndGrant(SUB)).status, 'invalid');
    assert.strictEqual(credits('u1'), 5);
  });

  await t('token for a different product → nothing granted', async () => {
    reset(); play.sub = activeSub({ lineItems: [{ productId: 'instaflow_pro_599' }] });
    assert.strictEqual((await verifyAndGrant(SUB)).status, 'invalid');
    assert.strictEqual(credits('u1'), 5);
  });

  await t('Play outage → nothing granted, queued; retry after recovery grants once', async () => {
    reset(); play.sub = httpErr(503);
    const r = await verifyAndGrant(SUB);
    assert.strictEqual(r.status, 'pending');
    assert.strictEqual(credits('u1'), 5);
    assert.strictEqual(pending().length, 1);
    play.sub = activeSub();
    await retryPendingVerifications();
    assert.strictEqual(credits('u1'), 1005);
    assert.strictEqual(pending().length, 0);
    await retryPendingVerifications();
    assert.strictEqual(credits('u1'), 1005);
  });

  await t('API access misconfigured (403) is retryable, not a grant', async () => {
    reset(); play.sub = httpErr(403);
    assert.strictEqual((await verifyAndGrant(SUB)).status, 'pending');
    assert.strictEqual(credits('u1'), 5);
  });

  await t('verified credit pack → 250 credits', async () => {
    reset(); play.product = { purchaseState: 0, orderId: 'GPA.2222', obfuscatedExternalAccountId: 'u1' };
    assert.strictEqual((await verifyAndGrant(PACK)).status, 'granted');
    assert.strictEqual(credits('u1'), 255);
  });

  await t('pending / cancelled pack payment → nothing granted', async () => {
    for (const purchaseState of [1, 2]) {
      reset(); play.product = { purchaseState, orderId: 'GPA.3333', obfuscatedExternalAccountId: 'u1' };
      assert.strictEqual((await verifyAndGrant(PACK)).status, 'invalid');
      assert.strictEqual(credits('u1'), 5);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
