/**
 * Text-to-Speech metering. Google bills TTS per character, so this route needs
 * a length ceiling and a length-proportional credit price — a flat cost would
 * let one long request outspend a whole AI generation.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const state = { balance: 100, spends: {}, apiCalls: 0 };

// Charging follows the CREDITS_ENABLED master switch, so the metering tests
// have to run with it on — otherwise they assert against a disabled system.
process.env.CREDITS_ENABLED = 'true';

const stubs = {
  axios: {
    post: async () => { state.apiCalls++; return { data: { audioContent: 'BASE64' } }; },
  },
  '../services/creditService': {
    getBalance: async () => state.balance,
    spend: async (_uid, cost, idemKey) => {
      if (state.spends[idemKey]) return true;
      if (state.balance < cost) return false;
      state.balance -= cost;
      state.spends[idemKey] = cost;
      return true;
    },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

process.env.GOOGLE_TTS_API_KEY = 'test-key';
const { synthesizeTts, creditsForText, MAX_CHARS } = require('../controllers/ttsController');

function call(text, languageCode = 'en-IN') {
  return new Promise((resolve) => {
    const req = { uid: 'u1', body: { text, languageCode } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    synthesizeTts(req, res);
  });
}

(async () => {
  console.log('TTS credit metering');

  await t('cost scales with length, never below 1 credit', () => {
    assert.strictEqual(creditsForText('hi'), 1, 'tiny text still costs 1');
    assert.strictEqual(creditsForText('x'.repeat(100)), 1);
    assert.strictEqual(creditsForText('x'.repeat(101)), 2);
    assert.strictEqual(creditsForText('x'.repeat(500)), 5);
    assert.strictEqual(creditsForText('x'.repeat(1000)), 10);
  });

  await t('text over the ceiling is rejected before any spend or API call', async () => {
    state.balance = 100; state.spends = {}; state.apiCalls = 0;
    const r = await call('x'.repeat(MAX_CHARS + 1));
    assert.strictEqual(r.status, 413);
    assert.strictEqual(r.body.error, 'TEXT_TOO_LONG');
    assert.strictEqual(state.apiCalls, 0, 'must not call Google');
    assert.strictEqual(state.balance, 100, 'must not charge');
  });

  await t('empty text is rejected', async () => {
    const r = await call('   ');
    assert.strictEqual(r.status, 400);
  });

  await t('a normal clip charges by length and returns audio', async () => {
    state.balance = 100; state.spends = {}; state.apiCalls = 0;
    const r = await call('x'.repeat(300));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.audioContent, 'BASE64');
    assert.strictEqual(state.balance, 97, '300 chars = 3 credits');
    assert.strictEqual(state.apiCalls, 1);
  });

  await t('replaying the same clip is free AND does not re-bill Google', async () => {
    const before = state.balance;
    const callsBefore = state.apiCalls;
    const r = await call('x'.repeat(300));
    assert.strictEqual(state.balance, before, 'must not charge the same clip twice');
    assert.strictEqual(state.apiCalls, callsBefore, 'must serve from cache, not re-synthesize');
    assert.strictEqual(r.body.cached, true);
  });

  await t('different text charges again', async () => {
    const before = state.balance;
    await call('y'.repeat(300));
    assert.strictEqual(state.balance, before - 3);
  });

  await t('insufficient credits → 403, and Google is never called', async () => {
    state.balance = 1; state.spends = {}; state.apiCalls = 0;
    const r = await call('z'.repeat(1000)); // 10 credits
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'INSUFFICIENT_CREDITS');
    assert.strictEqual(state.apiCalls, 0, 'must not spend API budget when unpaid');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
