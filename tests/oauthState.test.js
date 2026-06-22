const { createOAuthState, verifyOAuthState } = require('../utils/oauthState');

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
  console.log('OAuth state tests\n');
  process.env.OAUTH_STATE_SECRET = 'test-state-secret';

  await runTest('creates and verifies signed state', () => {
    const state = createOAuthState('user-123', 'instagram');
    const verified = verifyOAuthState(state, 'instagram');
    if (!verified.ok) throw new Error(`Expected verified state, got ${JSON.stringify(verified)}`);
    if (verified.uid !== 'user-123') throw new Error(`Expected uid user-123, got ${verified.uid}`);
  });

  await runTest('rejects tampered state', () => {
    const state = createOAuthState('user-123', 'google');
    const parts = state.split('.');
    const tampered = `${parts[0]}.${parts[1]}.invalid-signature`;
    const verified = verifyOAuthState(tampered, 'google');
    if (verified.ok) throw new Error('Expected tampered state to fail verification');
  });

  await runTest('rejects provider mismatch', () => {
    const state = createOAuthState('user-123', 'google');
    const verified = verifyOAuthState(state, 'instagram');
    if (verified.ok) throw new Error('Expected provider mismatch to fail');
  });

  await runTest('rejects expired state', () => {
    const state = createOAuthState('user-123', 'google', { ttlMs: 1 });
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const verified = verifyOAuthState(state, 'google');
        if (verified.ok) return reject(new Error('Expected expired state to fail'));
        resolve();
      }, 5);
    });
  });

  console.log('\nDone.');
}

run();
