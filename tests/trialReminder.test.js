/**
 * Trial-ending reminder: sent once, ~24h before the ₹5 trial converts, with
 * Play's renewal amount and the user's local date; never for a cancelled or
 * already-converted trial. Plus the admin comp entitlement (review account).
 */
const assert = require('assert');
const Module = require('module');
const http = require('http');
const express = require('express');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const { db, store } = createFakeFirestore();
const pushes = [];
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db },
  './pushService': { sendPushToUser: async (uid, msg) => { pushes.push({ uid, ...msg }); return { successCount: 1 }; } },
  './subscriptionSync': { TRIAL_REMINDERS: 'trial_reminders' },
  './aiAccess': { verifyUidFromToken: async (req) => (/^Bearer (\S+)$/.exec(req.headers.authorization || '') || [])[1] || null },
  '../controllers/adminNotificationsController': { previewCampaign: (q, r) => r.json({}), sendCampaign: (q, r) => r.json({}) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.warn = () => {};
const reminder = require('../services/trialReminder');
const adminRouter = require('../routes/adminNotifications');
console.log = quiet;

const H = 3600000;
const expiry = Date.UTC(2026, 9, 9, 20, 0); // 9 Oct 20:00 UTC = 10 Oct 01:30 IST
function trialUser(uid, over = {}) {
  store.set(`users/${uid}`, {
    utcOffsetMinutes: 330,
    entitlement: {
      active: true, isTrial: true, autoRenewing: true, latestOrderId: 'GPA.1',
      expiresAt: new Date(expiry), renewalPrice: { currencyCode: 'INR', units: '300', nanos: 0 }, ...over,
    },
  });
  store.set(`trial_reminders/${uid}`, { uid, orderId: 'GPA.1', dueAt: new Date(expiry - 24 * H), expiresAt: new Date(expiry) });
}
const now = expiry - 23 * H;

(async () => {
  console.log('Trial reminder + comp entitlement tests\n');

  await t('due trial → one push with Play amount and the local date', async () => {
    trialUser('u1');
    const r = await reminder.sendDueTrialReminders(now);
    assert.strictEqual(r.sent, 1);
    assert.strictEqual(pushes[0].uid, 'u1');
    assert.strictEqual(pushes[0].title, 'Your InstaFlow trial ends tomorrow');
    assert.ok(pushes[0].body.includes('₹300/month'), pushes[0].body);
    assert.ok(pushes[0].body.includes('10 Oct'), pushes[0].body); // IST date, not UTC
    assert.strictEqual(store.get('trial_reminders/u1'), undefined);
    assert.strictEqual(store.get('users/u1').entitlement.reminderSentFor, 'GPA.1');
  });

  await t('cron runs again → not sent twice', async () => {
    store.set('trial_reminders/u1', { uid: 'u1', orderId: 'GPA.1', dueAt: new Date(expiry - 24 * H) });
    assert.strictEqual((await reminder.sendDueTrialReminders(now)).sent, 0);
    assert.strictEqual(pushes.length, 1);
  });

  await t('trial cancelled (auto-renew off) → no reminder', async () => {
    trialUser('u2', { autoRenewing: false });
    assert.strictEqual((await reminder.sendDueTrialReminders(now)).sent, 0);
    assert.strictEqual(store.get('trial_reminders/u2'), undefined);
  });

  await t('account deleted → reminder dropped, user doc not recreated', async () => {
    store.set('trial_reminders/ghost', { uid: 'ghost', orderId: 'GPA.1', dueAt: new Date(expiry - 24 * H) });
    const before = pushes.length;
    await reminder.sendDueTrialReminders(now);
    assert.strictEqual(pushes.length, before);
    assert.strictEqual(store.get('users/ghost'), undefined);
    assert.strictEqual(store.get('trial_reminders/ghost'), undefined);
  });

  await t('not due yet → stays scheduled', async () => {
    trialUser('u3');
    assert.strictEqual((await reminder.sendDueTrialReminders(expiry - 30 * H)).sent, 0);
    assert.ok(store.get('trial_reminders/u3'));
  });

  await t('reminder text: price/date formatting', async () => {
    assert.strictEqual(reminder.formatPrice({ currencyCode: 'INR', units: '300', nanos: 0 }), '₹300');
    assert.strictEqual(reminder.formatDay(expiry, 0), '9 Oct');
    assert.ok(reminder.reminderText(null, expiry, 330).body.includes('monthly price'));
  });

  // ── admin comp entitlement ───────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const grant = (body, auth) => fetch(`${base}/admin/entitlement/grant`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  store.set('users/boss', { isAdmin: true });
  store.set('users/reviewer', { credits: 0 });
  const ok = { targetUid: 'reviewer', days: 90, reason: 'Play review account', requestId: 'comp-0001' };

  await t('comp entitlement: admin only', async () => {
    assert.strictEqual((await grant(ok)).status, 401);
    store.set('users/eve', { isAdmin: false });
    assert.strictEqual((await grant(ok, 'eve')).status, 403);
    assert.strictEqual(store.get('users/reviewer').entitlement, undefined);
  });

  await t('comp entitlement: active for N days, no credits, not everPaid; idempotent', async () => {
    const r = await grant(ok, 'boss');
    assert.strictEqual(r.status, 200);
    const e = store.get('users/reviewer').entitlement;
    assert.strictEqual(e.active, true);
    assert.strictEqual(e.source, 'admin_comp');
    assert.ok(Math.abs(e.expiresAt.getTime() - (Date.now() + 90 * 86400000)) < 60000);
    assert.notStrictEqual(e.everPaid, true);
    assert.strictEqual(store.get('users/reviewer').credits, 0);
    assert.strictEqual((await grant(ok, 'boss')).body.status, 'duplicate');
    assert.strictEqual((await grant({ ...ok, days: 0, requestId: 'comp-0002' }, 'boss')).status, 400);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
