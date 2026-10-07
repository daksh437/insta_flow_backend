/**
 * Marketing push policy: quiet hours (10 PM–9 AM IST), Daily Drop only on
 * Sun/Mon/Wed/Fri and not if the app was opened today, opt-outs, the
 * 4-per-7-days cap across every marketing push, "We miss you" at most once
 * per 7 days of inactivity, the day-1 tip once, admin campaigns under the same
 * rules, and the /account/notification-prefs endpoint.
 */
const assert = require('assert');
const Module = require('module');
const { createFakeFirestore } = require('./helpers/fakeFirestore');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const { db, store } = createFakeFirestore();
const sent = []; // { tokens, title }
let deadTokens = new Set();
const messaging = {
  sendEachForMulticast: async ({ tokens, notification }) => {
    sent.push({ tokens, title: notification.title });
    const responses = tokens.map((tk) => (deadTokens.has(tk)
      ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
      : { success: true }));
    return {
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
      responses,
    };
  },
};
const stubs = {
  '../utils/firestoreAdmin': { getDb: () => db, getAdmin: () => ({ messaging: () => messaging }) },
  '../middleware/verifyAuth': { requireAuth: (req, _res, next) => { req.uid = req.headers['x-test-uid']; next(); } },
  '../middleware/rateLimiters': { strictLimiter: (_q, _s, n) => n() },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.warn = () => {};
const policy = require('../services/notificationPolicy');
const marketingPush = require('../services/marketingPush');
const accountRouter = require('../routes/account');
const campaigns = require('../controllers/adminNotificationsController');
console.log = quiet;

const H = 3600000;
const D = 24 * H;
/** An instant given as IST wall-clock time. */
const istAt = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000);
const MON_7PM = istAt(2026, 10, 5, 19); // Monday 5 Oct 2026, 7 PM IST
const TUE_7PM = istAt(2026, 10, 6, 19);

function reset() { store.clear(); sent.length = 0; deadTokens = new Set(); }
function user(uid, over = {}) {
  store.set(`users/${uid}`, {
    fcmTokens: [`tok-${uid}`],
    lastActiveAt: new Date(MON_7PM.getTime() - 2 * D),
    createdAt: new Date(MON_7PM.getTime() - 30 * D),
    ...over,
  });
}
const doc = (uid) => store.get(`users/${uid}`);
const titlesTo = (uid) => sent.filter((s) => s.tokens.includes(`tok-${uid}`)).map((s) => s.title);

function route(method, url, uid, body) {
  return new Promise((resolve) => {
    const req = { method, url, body, headers: { 'x-test-uid': uid } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); return this; },
    };
    accountRouter.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}
function campaign(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(p) { resolve({ status: this.statusCode, body: p }); },
    };
    campaigns.sendCampaign({ adminUid: `admin-${Math.random()}`, body }, res);
  });
}

(async () => {
  console.log('Notification policy\n');

  await t('quiet hours are 10 PM–9 AM IST', () => {
    assert.strictEqual(policy.isQuietHour(istAt(2026, 10, 5, 21, 59)), false);
    assert.strictEqual(policy.isQuietHour(istAt(2026, 10, 5, 22, 0)), true);
    assert.strictEqual(policy.isQuietHour(istAt(2026, 10, 6, 3, 0)), true);
    assert.strictEqual(policy.isQuietHour(istAt(2026, 10, 6, 8, 59)), true);
    assert.strictEqual(policy.isQuietHour(istAt(2026, 10, 6, 9, 0)), false);
  });

  await t('Daily Drop days are Sun, Mon, Wed, Fri (IST)', () => {
    const days = [4, 5, 6, 7, 8, 9, 10].map((d) => policy.isDailyDropDay(istAt(2026, 10, d, 19)));
    // 4 Oct 2026 is a Sunday.
    assert.deepStrictEqual(days, [true, true, false, true, false, true, false]);
  });

  await t('opted-out, capped, opened-today and token-less users are skipped', () => {
    const base = { fcmTokens: ['t'], lastActiveAt: new Date(MON_7PM.getTime() - 2 * D) };
    assert.deepStrictEqual(policy.dailyDropDecision(base, MON_7PM), { ok: true });
    assert.strictEqual(policy.dailyDropDecision(base, TUE_7PM).reason, 'not_a_drop_day');
    assert.strictEqual(policy.dailyDropDecision({ ...base, lastActiveAt: istAt(2026, 10, 5, 9, 30) }, MON_7PM).reason, 'opened_today');
    assert.strictEqual(policy.dailyDropDecision({ ...base, notificationPrefs: { dailyIdeas: false } }, MON_7PM).reason, 'opted_out');
    const four = [1, 2, 3, 4].map((i) => MON_7PM.getTime() - i * D);
    assert.strictEqual(policy.dailyDropDecision({ ...base, marketingPushLog: four }, MON_7PM).reason, 'weekly_cap');
    const old = [8, 9, 10, 11].map((i) => MON_7PM.getTime() - i * D);
    assert.deepStrictEqual(policy.dailyDropDecision({ ...base, marketingPushLog: old }, MON_7PM), { ok: true });
    assert.strictEqual(policy.dailyDropDecision({ ...base, fcmTokens: [] }, MON_7PM).reason, 'no_tokens');
    // The "Daily ideas" toggle does not silence reminders, and vice versa.
    assert.strictEqual(policy.winbackDecision({ ...base, lastActiveAt: new Date(MON_7PM - 8 * D), notificationPrefs: { dailyIdeas: false } }, MON_7PM).ok, true);
    assert.strictEqual(policy.winbackDecision({ ...base, lastActiveAt: new Date(MON_7PM - 8 * D), notificationPrefs: { reminders: false } }, MON_7PM).reason, 'opted_out');
  });

  await t('"We miss you": only after 7 days inactive, once per 7 days, max 3 per streak', () => {
    const at = (days) => new Date(MON_7PM.getTime() - days * D);
    const u = { fcmTokens: ['t'] };
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(6) }, MON_7PM).reason, 'active');
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(7) }, MON_7PM).ok, true);
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(12), winback: { sentAt: at(3), count: 1 } }, MON_7PM).reason, 'winback_recent');
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(20), winback: { sentAt: at(7), count: 2 } }, MON_7PM).ok, true);
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(30), winback: { sentAt: at(8), count: 3 } }, MON_7PM).reason, 'winback_limit');
    // Came back after the last one, then went quiet again: a new streak.
    assert.strictEqual(policy.winbackDecision({ ...u, lastActiveAt: at(9), winback: { sentAt: at(10), count: 3 } }, MON_7PM).ok, true);
  });

  await t('day-1 tip: once, 20–48 h after signup', () => {
    const u = { fcmTokens: ['t'], lastActiveAt: new Date(MON_7PM - 30 * H) };
    assert.strictEqual(policy.onboardingTipDecision({ ...u, createdAt: new Date(MON_7PM - 10 * H) }, MON_7PM).reason, 'not_day_one');
    assert.strictEqual(policy.onboardingTipDecision({ ...u, createdAt: new Date(MON_7PM - 30 * H) }, MON_7PM).ok, true);
    assert.strictEqual(policy.onboardingTipDecision({ ...u, createdAt: new Date(MON_7PM - 30 * H), onboardingTipSentAt: new Date() }, MON_7PM).reason, 'already_sent');
    assert.strictEqual(policy.onboardingTipDecision({ ...u, createdAt: new Date(MON_7PM - 60 * H) }, MON_7PM).reason, 'not_day_one');
  });

  await t('Daily Drop run: only eligible users get it, and it is logged for the cap', async () => {
    reset();
    user('ok');
    user('opened', { lastActiveAt: istAt(2026, 10, 5, 10) });
    user('off', { notificationPrefs: { dailyIdeas: false } });
    user('capped', { marketingPushLog: [1, 2, 3, 4].map((i) => MON_7PM.getTime() - i * H) });
    user('notoken', { fcmTokens: [] });
    const r = await marketingPush.runScheduled('daily_drop', MON_7PM);
    assert.strictEqual(r.deliveredUsers, 1);
    assert.deepStrictEqual(titlesTo('ok'), ["🔥 Today's Viral Drop is ready"]);
    for (const uid of ['opened', 'off', 'capped', 'notoken']) assert.deepStrictEqual(titlesTo(uid), [], uid);
    assert.deepStrictEqual(doc('ok').marketingPushLog, [MON_7PM.getTime()]);
    assert.strictEqual(doc('off').marketingPushLog, undefined);
  });

  await t('no Daily Drop on Tuesday, none at all in quiet hours', async () => {
    reset();
    user('ok');
    assert.strictEqual((await marketingPush.runScheduled('daily_drop', TUE_7PM)).deliveredUsers, 0);
    const r = await marketingPush.runScheduled('winback', istAt(2026, 10, 5, 23, 0));
    assert.strictEqual(r.deliveredUsers, 0);
    assert.strictEqual(sent.length, 0);
  });

  await t('cap is shared: after 4 marketing pushes in 7 days the 5th kind is skipped', async () => {
    reset();
    user('u', { lastActiveAt: new Date(MON_7PM - 20 * D), createdAt: new Date(MON_7PM - 60 * D) });
    const days = [istAt(2026, 10, 4, 19), istAt(2026, 10, 5, 19), istAt(2026, 10, 7, 19), istAt(2026, 10, 9, 19)];
    for (const at of days) await marketingPush.runScheduled('daily_drop', at);
    assert.strictEqual(titlesTo('u').length, 4);
    const r = await marketingPush.runScheduled('winback', istAt(2026, 10, 10, 11));
    assert.strictEqual(r.deliveredUsers, 0);
    assert.strictEqual(r.skipped.weekly_cap, 1);
    // A week after the first one, room again.
    const later = await marketingPush.runScheduled('winback', istAt(2026, 10, 11, 20));
    assert.strictEqual(later.deliveredUsers, 1);
    assert.strictEqual(doc('u').winback.count, 1);
  });

  await t('dead tokens are removed; a user with no working token is not logged', async () => {
    reset();
    user('dead');
    deadTokens.add('tok-dead');
    const r = await marketingPush.runScheduled('daily_drop', MON_7PM);
    assert.strictEqual(r.deliveredUsers, 0);
    assert.deepStrictEqual(doc('dead').fcmTokens, []);
    assert.strictEqual(doc('dead').marketingPushLog, undefined);
  });

  await t('admin campaign: refused in quiet hours, otherwise respects opt-out and cap', async () => {
    reset();
    campaigns.clock.now = () => istAt(2026, 10, 5, 23);
    let r = await campaign({ segment: 'inactive', inactiveDays: 1, title: 'Hi', body: 'News' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'QUIET_HOURS');
    assert.strictEqual(sent.length, 0);
    const noon = istAt(2026, 10, 5, 12);
    campaigns.clock.now = () => noon;
    user('a');
    user('off', { notificationPrefs: { reminders: false } });
    user('capped', { marketingPushLog: [1, 2, 3, 4].map((i) => noon.getTime() - i * H) });
    r = await campaign({ segment: 'inactive', inactiveDays: 1, title: 'Hi', body: 'News' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(titlesTo('a'), ['Hi']);
    assert.deepStrictEqual(titlesTo('off'), []);
    assert.deepStrictEqual(titlesTo('capped'), []);
    assert.deepStrictEqual(doc('a').marketingPushLog, [noon.getTime()]);
  });

  await t('GET/PUT /account/notification-prefs: defaults on, booleans only, stored', async () => {
    reset();
    user('p');
    let r = await route('GET', '/notification-prefs', 'p');
    assert.deepStrictEqual(r.body.prefs, { dailyIdeas: true, reminders: true });
    r = await route('PUT', '/notification-prefs', 'p', { dailyIdeas: 'no' });
    assert.strictEqual(r.status, 400);
    r = await route('PUT', '/notification-prefs', 'p', { dailyIdeas: false });
    assert.deepStrictEqual(r.body.prefs, { dailyIdeas: false, reminders: true });
    assert.strictEqual(doc('p').notificationPrefs.dailyIdeas, false);
    assert.strictEqual((await marketingPush.runScheduled('daily_drop', MON_7PM)).deliveredUsers, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
