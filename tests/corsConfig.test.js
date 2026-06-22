const { buildCorsOptions } = require('../utils/corsConfig');

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

function runOriginCheck(corsOptions, origin) {
  return new Promise((resolve) => {
    corsOptions.origin(origin, (err, allowed) => {
      resolve({ err, allowed });
    });
  });
}

async function run() {
  console.log('CORS config tests\n');

  await runTest('dev allows all origins when CORS_ORIGINS empty', async () => {
    const options = buildCorsOptions([], false);
    const result = await runOriginCheck(options, 'https://random.dev');
    if (result.err) throw new Error('Expected no error in dev wildcard mode');
    if (result.allowed !== true) throw new Error('Expected allowed=true');
  });

  await runTest('prod allows configured origin', async () => {
    const options = buildCorsOptions(['https://app.example.com'], true);
    const result = await runOriginCheck(options, 'https://app.example.com');
    if (result.err) throw new Error(`Expected allowed origin in prod, got ${result.err.message}`);
    if (result.allowed !== true) throw new Error('Expected allowed=true');
  });

  await runTest('prod blocks unknown origin', async () => {
    const options = buildCorsOptions(['https://app.example.com'], true);
    const result = await runOriginCheck(options, 'https://evil.example.com');
    if (!result.err) throw new Error('Expected unknown origin to be blocked');
  });

  console.log('\nDone.');
}

run();
