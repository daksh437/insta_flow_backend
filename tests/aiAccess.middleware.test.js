/**
 * Unit tests for AI usage middleware limit check.
 * Run: NODE_ENV=test node tests/aiAccess.middleware.test.js
 *
 * Tests:
 * - no Firebase ID token → 401 UNAUTHORIZED (the raw x-user-uid header is not trusted)
 * - AI_REQUIRE_TOKEN=false + CREDITS_ENABLED off → allowed, next() called
 * - wrapAiHandler blocks when req.aiAccessAllowed !== true
 * - wrapAiHandler allows when req.aiAccessAllowed === true
 *
 * Credit charging (CREDITS_ENABLED=true) is covered by creditRace.test.js.
 */

process.env.NODE_ENV = 'test';
delete process.env.DEV_SKIP_LIMITS;
delete process.env.CREDITS_ENABLED;

// aiAccess reads its env switches once at load, so load a fresh copy per config.
function loadAiAccess(env) {
  const modPath = require.resolve('../middleware/aiAccess');
  delete require.cache[modPath];
  const saved = process.env.AI_REQUIRE_TOKEN;
  if (env.AI_REQUIRE_TOKEN === undefined) delete process.env.AI_REQUIRE_TOKEN;
  else process.env.AI_REQUIRE_TOKEN = env.AI_REQUIRE_TOKEN;
  const mod = require(modPath);
  if (saved === undefined) delete process.env.AI_REQUIRE_TOKEN;
  else process.env.AI_REQUIRE_TOKEN = saved;
  return mod;
}

const { requireAiAccess, wrapAiHandler, DAILY_CREDITS_FREE } = loadAiAccess({});

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

  await runTest('no auth token → 401 UNAUTHORIZED (x-user-uid header alone is not trusted)', async () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await requireAiAccess(req, res, next);
    if (res.statusCode !== 401) throw new Error(`Expected status 401, got ${res.statusCode}`);
    if (res.body?.error !== 'UNAUTHORIZED') throw new Error(`Expected error UNAUTHORIZED, got ${res.body?.error}`);
    if (nextCalled) throw new Error('Expected next() not to be called without a token');
  });

  await runTest('AI_REQUIRE_TOKEN=false + credits off → allowed, next() called', async () => {
    const { requireAiAccess: headerTrustAccess } = loadAiAccess({ AI_REQUIRE_TOKEN: 'false' });
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    await headerTrustAccess(req, res, next);
    if (res.statusCode) throw new Error(`Expected no error status, got ${res.statusCode} ${JSON.stringify(res.body)}`);
    if (!nextCalled) throw new Error('Expected next() to be called when allowed');
    if (req.uid !== 'test-uid-123') throw new Error(`Expected req.uid test-uid-123, got ${req.uid}`);
    if (req.aiAccessAllowed !== true) throw new Error('Expected req.aiAccessAllowed === true');
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
