/**
 * Admin credit adjustments go through the backend with a ledger entry, and
 * admin identity comes only from a verified token (not the x-user-uid header).
 */
const assert = require('assert');
const Module = require('module');
const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

// in-memory Firestore
const store = new Map();
let autoId = 0;
const docRef = (path) => ({
  path,
  collection: (c) => collectionRef(`${path}/${c}`),
  get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
  set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...data } : data); },
});
const collectionRef = (path) => ({ doc: (id) => docRef(`${path}/${id || `auto${++autoId}`}`) });
const db = {
  collection: collectionRef,
  runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => { r.set(d, o); } }),
};

// Token → uid ("Bearer <uid>" stands in for a verified token).
const verifyUidFromToken = async (req) => {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
};
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db },
  './aiAccess': { verifyUidFromToken },
  '../controllers/adminNotificationsController': { previewCampaign: (q, r) => r.json({}), sendCampaign: (q, r) => r.json({}) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.error = () => {};
const router = require('../routes/adminNotifications');
console.log = quiet;

const app = express();
app.use(express.json());
app.use('/admin', router);

let base;
const call = async (body, headers = {}) => {
  const r = await fetch(`${base}/admin/credits/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const ledger = (uid) => [...store.entries()].filter(([k]) => k.startsWith(`users/${uid}/credit_transactions/`)).map(([, v]) => v);
const ADMIN = { authorization: 'Bearer boss' };
const ok = { targetUid: 'u1', amount: 100, reason: 'Refund goodwill', requestId: 'req-0001-abc' };

(async () => {
  const server = http.createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  store.set('users/boss', { isAdmin: true, email: 'boss@x.com' });
  store.set('users/u1', { credits: 10 });
  store.set('users/eve', { isAdmin: false });

  console.log('Admin credit tests\n');

  await t('spoofed x-user-uid header without a token → 401, nothing changes', async () => {
    const r = await call(ok, { 'x-user-uid': 'boss' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(store.get('users/u1').credits, 10);
  });

  await t('signed-in non-admin → 403', async () => {
    const r = await call(ok, { authorization: 'Bearer eve' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(store.get('users/u1').credits, 10);
  });

  await t('admin grant → balance updated with a matching ledger entry', async () => {
    const r = await call(ok, ADMIN);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.balance, 110);
    assert.strictEqual(store.get('users/u1').credits, 110);
    const l = ledger('u1');
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].type, 'admin_adjustment');
    assert.strictEqual(l[0].amount, 100);
    assert.strictEqual(l[0].balanceAfter, 110);
    assert.strictEqual(l[0].meta.adminUid, 'boss');
  });

  await t('same requestId again (double tap) → applied once', async () => {
    const r = await call(ok, ADMIN);
    assert.strictEqual(r.body.status, 'duplicate');
    assert.strictEqual(store.get('users/u1').credits, 110);
    assert.strictEqual(ledger('u1').length, 1);
  });

  await t('deduction below zero → refused', async () => {
    const r = await call({ ...ok, amount: -500, requestId: 'req-0002-abc' }, ADMIN);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'INSUFFICIENT_BALANCE');
    assert.strictEqual(store.get('users/u1').credits, 110);
  });

  await t('missing reason / bad amount → 400', async () => {
    assert.strictEqual((await call({ ...ok, reason: '', requestId: 'req-0003-abc' }, ADMIN)).status, 400);
    assert.strictEqual((await call({ ...ok, amount: 1.5, requestId: 'req-0004-abc' }, ADMIN)).status, 400);
    assert.strictEqual((await call({ ...ok, amount: 0, requestId: 'req-0005-abc' }, ADMIN)).status, 400);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
