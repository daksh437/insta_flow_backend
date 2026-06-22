const { apiSuccess, apiError } = require('../utils/response');

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

function mockRes() {
  const out = { statusCode: 200, body: null };
  out.status = function status(code) {
    out.statusCode = code;
    return out;
  };
  out.json = function json(body) {
    out.body = body;
    return out;
  };
  return out;
}

async function run() {
  console.log('Response contract tests\n');

  await runTest('apiSuccess includes success=true and ok=true', () => {
    const res = mockRes();
    apiSuccess(res, { value: 1 });
    if (res.body.success !== true) throw new Error('Expected success=true');
    if (res.body.ok !== true) throw new Error('Expected ok=true');
    if (!res.body.data || res.body.data.value !== 1) throw new Error('Expected data payload');
  });

  await runTest('apiError includes success=false and ok=false', () => {
    const res = mockRes();
    apiError(res, 400, 'BAD_REQUEST', 'Invalid input');
    if (res.statusCode !== 400) throw new Error(`Expected status 400, got ${res.statusCode}`);
    if (res.body.success !== false) throw new Error('Expected success=false');
    if (res.body.ok !== false) throw new Error('Expected ok=false');
    if (res.body.code !== 'BAD_REQUEST') throw new Error('Expected code BAD_REQUEST');
  });

  console.log('\nDone.');
}

run();
