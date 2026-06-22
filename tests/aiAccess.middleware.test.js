/**
 * Unit tests for AI usage middleware limit check.
 * Run: NODE_ENV=test node tests/aiAccess.middleware.test.js
 *
 * Tests:
 * - dailyAiUsed = 2 (free plan) → blocked (403 DAILY_LIMIT_REACHED)
 * - dailyAiUsed = 1 (free plan) → allowed (next() called)
 * - premium → unlimited (allowed)
 * - wrapAiHandler blocks when req.aiAccessAllowed !== true
 * - wrapAiHandler allows when req.aiAccessAllowed === true
 */

process.env.NODE_ENV = 'test';

const { requireAiAccess, wrapAiHandler, DAILY_CREDITS_FREE } = require('../middleware/aiAccess');

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function mockReq(overrides = {}) {
  return {
    headers: { 'x-user-uid': 'test-uid-123' },
    baseUrl: '',
    path: '/ai/captions',
    _aiEndpoint: '/captions',
    ...overrides,
  };
}

function mockRes() {
  const out = { statusCode: null, body: null };
  out.status = function (code) {
    out.statusCode = code;
    return out;
  };
  out.json = function (body) {
    out.body = body;
    return out;
  };
  return out;
}

async function run() {
  console.log('AI access middleware limit check tests\n');

  await runTest('DAILY_CREDITS_FREE is 2', () => {
    if (DAILY_CREDITS_FREE !== 2) throw new Error(`Expected DAILY_CREDITS_FREE 2, got ${DAILY_CREDITS_FREE}`);
  });

  await runTest('dailyAiUsed = 2 (free plan) → blocked with 403 DAILY_LIMIT_REACHED', async () => {
    const req = mockReq({ _mockAiAccess: { planType: 'free', dailyUsed: 2, allowed: false, user: {} } });
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await requireAiAccess(req, res, next);
    if (res.statusCode !== 403) throw new Error(`Expected status 403, got ${res.statusCode}`);
    if (res.body && res.body.code !== 'DAILY_LIMIT_REACHED') throw new Error(`Expected code DAILY_LIMIT_REACHED, got ${res.body && res.body.code}`);
    if (nextCalled) throw new Error('Expected next() not to be called when blocked');
  });

  await runTest('dailyAiUsed = 1 (free plan) → allowed, next() called', async () => {
    const req = mockReq({ _mockAiAccess: { planType: 'free', dailyUsed: 1, allowed: true, creditsLeftToday: 1, user: { dailyAiUsed: 1 } } });
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await requireAiAccess(req, res, next);
    if (res.statusCode === 403) throw new Error(`Expected not 403, got 403 with body ${JSON.stringify(res.body)}`);
    if (!nextCalled) throw new Error('Expected next() to be called when allowed');
  });

  await runTest('premium → allowed (unlimited)', async () => {
    const req = mockReq({ _mockAiAccess: { planType: 'premium', dailyUsed: 999, allowed: true, user: {} } });
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await requireAiAccess(req, res, next);
    if (res.statusCode === 403) throw new Error(`Expected premium to be allowed, got 403`);
    if (!nextCalled) throw new Error('Expected next() to be called for premium');
    if (req.aiAccessAllowed !== true) throw new Error('Expected req.aiAccessAllowed === true for premium');
  });

  await runTest('wrapAiHandler blocks when req.aiAccessAllowed !== true', async () => {
    const handler = wrapAiHandler(() => {});
    const req = mockReq({ aiAccessAllowed: false });
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await handler(req, res, next);
    if (res.statusCode !== 403) throw new Error(`Expected 403 when aiAccessAllowed false, got ${res.statusCode}`);
    if (res.body?.code !== 'DAILY_LIMIT_REACHED') throw new Error(`Expected DAILY_LIMIT_REACHED, got ${res.body?.code}`);
  });

  await runTest('wrapAiHandler allows when req.aiAccessAllowed === true', async () => {
    let handlerRan = false;
    const handler = wrapAiHandler((req, res, next) => {
      handlerRan = true;
      next();
    });
    const req = mockReq({ aiAccessAllowed: true });
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await handler(req, res, next);
    if (!handlerRan) throw new Error('Expected handler to run when aiAccessAllowed true');
    if (res.statusCode === 403) throw new Error('Expected not 403 when allowed');
  });

  console.log('\nDone.');
}

run();
