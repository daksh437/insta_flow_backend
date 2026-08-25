/**
 * Daily Viral Drop metering: opt-in default-off, one charge per UTC day, and
 * no generation at all for users who never turned it on.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

// ── Stub the route's dependencies before requiring it ────────────────────
const state = {
  enabled: false,
  balance: 100,
  spends: {},        // idemKey -> cost
  generated: 0,      // how many times Gemini generation was invoked
};

const origResolve = Module._resolveFilename;
const stubs = {
  '../middleware/verifyAuth': { requireAuth: (req, _res, next) => { req.uid = 'u1'; next(); } },
  '../utils/firestoreAdmin': {
    getDb: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ dailyDropEnabled: state.enabled }) }),
          set: async (d) => { if ('dailyDropEnabled' in d) state.enabled = d.dailyDropEnabled; },
        }),
      }),
    }),
  },
  '../services/creditService': {
    getBalance: async () => state.balance,
    spend: async (_uid, cost, idemKey) => {
      if (state.spends[idemKey]) return true;      // already charged today
      if (state.balance < cost) return false;
      state.balance -= cost;
      state.spends[idemKey] = cost;
      return true;
    },
  },
  '../services/dailyDropGenerator': {
    getTodayDrop: () => { state.generated++; return { date: 'x', trend_theme: 'T' }; },
    generateDailyDrop: async () => { state.generated++; return { date: 'x', trend_theme: 'T' }; },
    generatePersonalizedDrop: async () => null,
  },
};
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const router = require('../routes/dailyDrop');

// Minimal express-router driver: find the layer for method+path and run it.
function call(method, path, body = {}) {
  return new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url: path, body, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

(async () => {
  console.log('Daily Drop credit metering');

  await ta('default is OFF — no drop, no generation, no charge', async () => {
    state.enabled = false; state.generated = 0; state.balance = 100; state.spends = {};
    const r = await call('get', '/today');
    assert.strictEqual(r.body.enabled, false, 'should report disabled');
    assert.strictEqual(r.body.drop, null, 'should not return a drop');
    assert.strictEqual(state.generated, 0, 'must not invoke generation');
    assert.strictEqual(state.balance, 100, 'must not charge');
  });

  await ta('POST /preference turns it on', async () => {
    const r = await call('post', '/preference', { enabled: true });
    assert.strictEqual(r.body.enabled, true);
    assert.strictEqual(state.enabled, true);
  });

  await ta('first fetch of the day charges 5 credits and returns a drop', async () => {
    state.generated = 0; state.balance = 100; state.spends = {};
    const r = await call('get', '/today');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.drop, 'should return a drop');
    assert.strictEqual(state.balance, 95, 'should charge exactly 5');
  });

  await ta('second fetch same day is free (idempotent per UTC day)', async () => {
    const before = state.balance;
    await call('get', '/today');
    assert.strictEqual(state.balance, before, 'must not charge twice in a day');
  });

  await ta('insufficient credits → 403, and nothing is generated', async () => {
    state.balance = 2; state.spends = {}; state.generated = 0;
    const r = await call('get', '/today');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'INSUFFICIENT_CREDITS');
    assert.strictEqual(state.generated, 0, 'must not spend API budget when unpaid');
  });

  await ta('turning it off stops generation again', async () => {
    await call('post', '/preference', { enabled: false });
    state.generated = 0; state.balance = 100; state.spends = {};
    const r = await call('get', '/today');
    assert.strictEqual(r.body.enabled, false);
    assert.strictEqual(state.generated, 0);
    assert.strictEqual(state.balance, 100);
  });

  await ta('POST /preference rejects a non-boolean', async () => {
    const r = await call('post', '/preference', { enabled: 'yes' });
    assert.strictEqual(r.status, 400);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
