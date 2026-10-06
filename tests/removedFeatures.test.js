/**
 * Removed features answer 410 FEATURE_REMOVED (old app builds show the
 * message); Meta's data-deletion callbacks still work.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const stubs = { '../utils/firestoreAdmin': { getDb: () => null, getAdmin: () => null } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const app = express();
app.use(express.json());
app.use(require('../routes/removedFeatures'));
app.use('/auth', require('../routes/auth'));

(async () => {
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('Removed features\n');

  const cases = [
    ['POST', '/instagram-connect', 'Instagram scheduling has been removed from InstaFlow.'],
    ['GET', '/instagram-stats', 'Instagram scheduling has been removed from InstaFlow.'],
    ['POST', '/instagram/media/publish', 'Instagram scheduling has been removed from InstaFlow.'],
    ['POST', '/scheduler/schedule-post', 'Instagram scheduling has been removed from InstaFlow.'],
    ['GET', '/scheduler/scheduled-posts', 'Instagram scheduling has been removed from InstaFlow.'],
    ['GET', '/auth/instagram/callback', 'Instagram scheduling has been removed from InstaFlow.'],
    ['POST', '/calendar/create-event', 'Google Calendar integration has been removed from InstaFlow.'],
    ['GET', '/auth/google', 'Google Calendar integration has been removed from InstaFlow.'],
    ['GET', '/auth/status', 'Google Calendar integration has been removed from InstaFlow.'],
  ];
  for (const [method, path, message] of cases) {
    await t(`${method} ${path} → 410 FEATURE_REMOVED`, async () => {
      const r = await fetch(base + path, { method });
      assert.strictEqual(r.status, 410);
      const body = await r.json();
      assert.strictEqual(body.error, 'FEATURE_REMOVED');
      assert.strictEqual(body.message, message);
    });
  }

  await t('Meta data-deletion callback still answers 200 (unsigned request → nothing deleted)', async () => {
    const r = await fetch(base + '/auth/instagram/data-deletion', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_request: 'bad.sig' }),
    });
    assert.strictEqual(r.status, 200);
    assert.ok((await r.json()).confirmation_code.startsWith('unverified-'));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
