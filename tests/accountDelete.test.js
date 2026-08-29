/**
 * Account deletion must actually delete.
 *
 * The client-side version deleted one document and left behind every
 * subcollection, every uid-keyed row, every Storage object and the Auth user
 * itself — while telling the user their data was permanently gone.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

// ── Minimal in-memory Firestore/Storage/Auth doubles ────────────────────────
const state = {};
function reset() {
  state.sub = {
    credit_transactions: 3, credit_spends: 2, devices: 1, instagram_data: 1,
    notifications: 5, personalized_drops: 2, referrals: 0, studio: 4,
    tool_usage: 7, legacy_extra: 2, // not in the explicit list — must still go
  };
  state.top = {
    feedback: 1, ai_reports: 0, posts: 2, calendar_history: 1, script_history: 3,
    ai_history: 4, ai_usage_logs: 9, scheduled_posts: 1, credit_grants: 2,
  };
  state.storage = [
    'studio_images/u1/a.png', 'studio_images/u1/b.png',
    'users/u1/profile_avatar.jpg', 'instagram_publish/u1/v.mp4',
    'studio_images/OTHER/keep.png', // another user's file — must survive
  ];
  state.userDocDeleted = false;
  state.authDeleted = null;
  state.batches = 0;
}

function makeQuery(countRef, label) {
  const q = {
    limit: () => q,
    firestore: { batch: () => ({ delete() {}, commit: async () => { state.batches++; } }) },
    get: async () => {
      const n = countRef();
      const size = Math.min(n, 400);
      const docs = Array.from({ length: size }, () => ({ ref: {} }));
      countRef(0);
      return { empty: size === 0, size, docs };
    },
  };
  return q;
}
function counter(bag, key) {
  return (set) => { if (set === 0) bag[key] = 0; return bag[key]; };
}

const stubs = {
  '../middleware/verifyAuth': { requireAuth: (req, _res, next) => { req.uid = 'u1'; next(); } },
  '../middleware/rateLimiters': { strictLimiter: (_q, _s, n) => n() },
  '../utils/firestoreAdmin': {
    getDb: () => ({
      collection: (name) => ({
        doc: () => ({
          collection: (sub) => makeQuery(counter(state.sub, sub), sub),
          listCollections: async () => Object.keys(state.sub).map((id) => ({
            id, ...makeQuery(counter(state.sub, id), id),
          })),
          delete: async () => { state.userDocDeleted = true; },
        }),
        where: () => makeQuery(counter(state.top, name), name),
      }),
    }),
    getAdmin: () => ({
      storage: () => ({
        bucket: () => ({
          getFiles: async ({ prefix }) => [
            state.storage.filter((p) => p.startsWith(prefix)).map((p) => ({
              name: p,
              delete: async () => { state.storage = state.storage.filter((x) => x !== p); },
            })),
          ],
        }),
      }),
      auth: () => ({ deleteUser: async (uid) => { state.authDeleted = uid; } }),
    }),
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const router = require('../routes/account');

function call() {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: '/delete', body: {}, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); return this; },
    };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

(async () => {
  console.log('Account deletion');
  reset();
  const r = await call();

  await t('responds ok', () => {
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.success, true);
  });

  await t('every named subcollection is emptied', () => {
    for (const [k, v] of Object.entries(state.sub)) {
      assert.strictEqual(v, 0, `${k} still has ${v} docs`);
    }
  });

  await t('an unlisted subcollection is emptied too', () => {
    assert.strictEqual(state.sub.legacy_extra, 0, 'listCollections sweep must catch it');
  });

  await t('uid-keyed top-level rows are removed', () => {
    for (const [k, v] of Object.entries(state.top)) {
      assert.strictEqual(v, 0, `${k} still has ${v} docs`);
    }
  });

  await t("this user's Storage objects are removed", () => {
    const mine = state.storage.filter((p) => p.includes('/u1/'));
    assert.deepStrictEqual(mine, [], `left behind: ${mine.join(', ')}`);
  });

  await t("another user's Storage objects are untouched", () => {
    assert.ok(state.storage.includes('studio_images/OTHER/keep.png'), 'must not delete other users');
  });

  await t('the user document is deleted', () => {
    assert.strictEqual(state.userDocDeleted, true);
  });

  await t('the Firebase Auth user is deleted — the step the old flow skipped', () => {
    assert.strictEqual(state.authDeleted, 'u1',
      'without this the same Google account signs straight back in');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
