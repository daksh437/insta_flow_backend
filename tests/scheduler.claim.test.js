const { __test } = require('../services/scheduler_service');

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

async function run() {
  console.log('Scheduler claim tests\n');

  await runTest('pending unlocked post is claimable', () => {
    const claimable = __test.shouldClaimPost({ status: 'pending' }, Date.now());
    if (!claimable) throw new Error('Expected pending unlocked post to be claimable');
  });

  await runTest('pending but locked post is not claimable', () => {
    const claimable = __test.shouldClaimPost(
      {
        status: 'pending',
        processing: { lockedUntilMs: Date.now() + 60_000 },
      },
      Date.now()
    );
    if (claimable) throw new Error('Expected active locked post to be non-claimable');
  });

  await runTest('non-pending post is not claimable', () => {
    const claimable = __test.shouldClaimPost({ status: 'processing' }, Date.now());
    if (claimable) throw new Error('Expected non-pending post to be non-claimable');
  });

  console.log('\nDone.');
}

run();
