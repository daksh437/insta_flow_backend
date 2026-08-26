/**
 * Credits must be taken BEFORE the AI call, atomically.
 *
 * The Rewrite Tool fires 5 requests at once (one per tone) and Bio Maker 3.
 * When the middleware only *read* the balance and the deduction happened after
 * the generation, all 5 passed the same stale read: a user with 1 credit got 5
 * generations, was charged 1, and we paid for 5 API calls.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const tick = () => new Promise((r) => setImmediate(r));
const state = { balance: 0, spends: {} };

const stubs = {
  '../services/creditService': {
    costForPath: () => 1,
    labelForEndpoint: () => 'Rewrite Tool',
    getBalance: async () => { await tick(); return state.balance; },
    // Mirrors the real transaction: async round trip, then atomic check+write.
    spend: async (_uid, cost, idemKey) => {
      await tick();
      if (state.spends[idemKey]) return true;
      if (state.balance < cost) return false;
      state.balance -= cost;
      state.spends[idemKey] = cost;
      return true;
    },
    refund: async (_uid, idemKey) => {
      await tick();
      const cost = state.spends[idemKey];
      if (!cost) return false;
      state.balance += cost;
      delete state.spends[idemKey];
      return true;
    },
  },
  '../utils/firestoreAdmin': { getDb: () => null, getAdmin: () => null },
  '../utils/ensureUserAiFields': { ensureUserAiFields: async () => {} },
  '../services/planResolver': { resolvePlan: () => 'free', toDate: () => null },
  '../utils/aiFallback': { buildAiFallback: () => ({ fallback: true }) },
  '../utils/playVerify': { verifySubscription: async () => null },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.CREDITS_ENABLED = 'true';
process.env.AI_REQUIRE_TOKEN = 'false'; // let the stubbed header uid through
const { requireAiAccess, refundAiCharge } = require('../middleware/aiAccess');

/** One tone request through the middleware; resolves 'allowed' or 'blocked'. */
function runRequest(tone) {
  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      path: '/rewrite',
      _aiEndpoint: '/ai/rewrite',
      headers: { 'x-user-uid': 'u1', 'x-idempotency-key': `rewrite-${tone}` },
      body: { tone },
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json() { resolve({ outcome: 'blocked', req }); return this; },
    };
    requireAiAccess(req, res, () => resolve({ outcome: 'allowed', req }));
  });
}

(async () => {
  console.log('Credit charged before the AI call');

  await t('5 parallel tones with 1 credit → only 1 gets through', async () => {
    state.balance = 1; state.spends = {};
    const tones = ['simple', 'attractive', 'seo', 'engaging', 'professional'];
    const results = await Promise.all(tones.map(runRequest));
    const allowed = results.filter((r) => r.outcome === 'allowed').length;
    assert.strictEqual(allowed, 1, `expected 1 allowed, got ${allowed}`);
    assert.strictEqual(state.balance, 0, 'exactly 1 credit should be spent');
  });

  await t('5 parallel tones with 5 credits → all 5 get through, all charged', async () => {
    state.balance = 5; state.spends = {};
    const tones = ['simple', 'attractive', 'seo', 'engaging', 'professional'];
    const results = await Promise.all(tones.map(runRequest));
    assert.strictEqual(results.filter((r) => r.outcome === 'allowed').length, 5);
    assert.strictEqual(state.balance, 0, 'all 5 credits should be spent');
  });

  await t('3 parallel bio styles with 2 credits → only 2 get through', async () => {
    state.balance = 2; state.spends = {};
    const results = await Promise.all(['short', 'long', 'aesthetic'].map(runRequest));
    assert.strictEqual(results.filter((r) => r.outcome === 'allowed').length, 2);
    assert.strictEqual(state.balance, 0);
  });

  await t('the charge lands before next() runs', async () => {
    state.balance = 1; state.spends = {};
    const r = await runRequest('solo');
    assert.strictEqual(r.outcome, 'allowed');
    assert.strictEqual(state.balance, 0, 'balance must already be debited when the handler starts');
    assert.strictEqual(r.req._creditCharged, true);
  });

  await t('a failed generation is refunded and the key cleared', async () => {
    state.balance = 1; state.spends = {};
    const r = await runRequest('boom');
    assert.strictEqual(state.balance, 0, 'charged up front');
    await refundAiCharge('u1', 'rewrite-boom', '/ai/rewrite');
    assert.strictEqual(state.balance, 1, 'credit returned');
    assert.strictEqual(state.spends['rewrite-boom'], undefined, 'key cleared so a retry charges fresh');
  });

  await t('retrying the identical request is not charged twice', async () => {
    state.balance = 2; state.spends = {};
    await runRequest('same');
    assert.strictEqual(state.balance, 1);
    await runRequest('same'); // same idempotency key
    assert.strictEqual(state.balance, 1, 'must not double-charge a retry');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
