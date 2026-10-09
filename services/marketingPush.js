/**
 * Marketing pushes (Daily Drop, "We miss you", day-1 tip, admin campaigns),
 * filtered per user by services/notificationPolicy.js. Every delivered push
 * is written to users/{uid}.marketingPushLog so the weekly cap holds across
 * all of them. Account messages (trial reminder) use pushService directly.
 */
const { getAdmin, getDb } = require('../utils/firestoreAdmin');
const policy = require('./notificationPolicy');

const USER_SCAN_LIMIT = 5000;

const MESSAGES = {
  daily_drop: {
    category: 'daily_ideas',
    decide: policy.dailyDropDecision,
    title: "🔥 Today's Viral Drop is ready",
    body: 'A trending idea, hook and hashtags for your niche. Tap to create your post.',
    data: { deepLink: '/daily-viral-drop', type: 'daily_drop' },
  },
  winback: {
    category: 'reminders',
    decide: policy.winbackDecision,
    title: 'We miss you 👋',
    body: 'Your next post idea is ready. Create it in one tap ✨',
    data: { deepLink: '/daily-viral-drop', type: 'winback' },
  },
  onboarding_tip: {
    category: 'reminders',
    decide: policy.onboardingTipDecision,
    title: '✨ Try this',
    body: 'Create a scroll-stopping caption in one tap. Open AI Tools.',
    data: { deepLink: '/ai-tools', type: 'onboarding_tip' },
  },
};

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Fields to write for a user who just received [kind] at [now]. */
function deliveredUpdate(user, kind, now) {
  const log = policy.recentLog(user, now);
  const update = { marketingPushLog: [...log, now.getTime()] };
  if (kind === 'winback') {
    const wb = user.winback || {};
    const last = policy.toDate(user.lastActiveAt) || policy.toDate(user.lastActive) || policy.toDate(user.lastSeen);
    const sentAt = policy.toDate(wb.sentAt);
    const sameStreak = sentAt && last && sentAt > last;
    update.winback = { sentAt: now, count: sameStreak ? (Number(wb.count) || 0) + 1 : 1 };
  }
  if (kind === 'onboarding_tip') update.onboardingTipSentAt = now;
  return update;
}

/**
 * Sends one message to [recipients] ({ uid, user }) and records delivery.
 * @returns {{ targetUsers, deliveredUsers, successCount, failureCount }}
 */
async function deliver({ recipients, title, body, data, kind, now }) {
  const admin = getAdmin();
  const db = getDb();
  const result = { targetUsers: recipients.length, deliveredUsers: 0, successCount: 0, failureCount: 0 };
  if (!admin || !db || recipients.length === 0) return result;

  const owners = []; // token index → recipient
  const tokens = [];
  for (const r of recipients) {
    for (const t of policy.tokensOf(r.user)) {
      tokens.push(t);
      owners.push(r);
    }
  }
  const sender = admin.messaging().sendEachForMulticast
    ? admin.messaging().sendEachForMulticast.bind(admin.messaging())
    : admin.messaging().sendMulticast.bind(admin.messaging());
  const stringData = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)]));

  const delivered = new Set();
  const dead = new Map(); // uid → Set(token)
  let offset = 0;
  for (const batch of chunk(tokens, 500)) {
    const resp = await sender({
      tokens: batch,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high', notification: { channelId: 'general' } },
    });
    result.successCount += Number(resp.successCount || 0);
    result.failureCount += Number(resp.failureCount || 0);
    (resp.responses || []).forEach((r, i) => {
      const owner = owners[offset + i];
      if (r.success) {
        delivered.add(owner);
        return;
      }
      const code = (r.error && r.error.code) || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        if (!dead.has(owner.uid)) dead.set(owner.uid, new Set());
        dead.get(owner.uid).add(batch[i]);
      }
    });
    offset += batch.length;
  }

  for (const r of recipients) {
    const update = delivered.has(r) ? deliveredUpdate(r.user, kind, now) : {};
    const deadTokens = dead.get(r.uid);
    if (deadTokens) {
      const existing = Array.isArray(r.user.fcmTokens) ? r.user.fcmTokens : [];
      update.fcmTokens = existing.filter((t) => !deadTokens.has(String(t)));
    }
    if (Object.keys(update).length) {
      await db.collection('users').doc(r.uid).update(update).catch(() => null);
    }
  }
  result.deliveredUsers = delivered.size;
  return result;
}

/**
 * Scheduled marketing push [kind] (see MESSAGES): every user the policy
 * allows right now gets it once.
 */
async function runScheduled(kind, now = new Date()) {
  const msg = MESSAGES[kind];
  if (!msg) throw new Error(`unknown marketing push ${kind}`);
  const db = getDb();
  if (!db) return { targetUsers: 0, deliveredUsers: 0, skipped: {} };
  if (policy.isQuietHour(now)) return { targetUsers: 0, deliveredUsers: 0, skipped: { quiet_hours: 'all' } };

  const snap = await db.collection('users').limit(USER_SCAN_LIMIT).get();
  const recipients = [];
  const skipped = {};
  for (const doc of snap.docs) {
    const user = doc.data() || {};
    const d = msg.decide(user, now);
    if (d.ok) recipients.push({ uid: doc.id, user });
    else skipped[d.reason] = (skipped[d.reason] || 0) + 1;
  }
  const res = await deliver({ recipients, title: msg.title, body: msg.body, data: msg.data, kind, now });
  console.log(`[marketingPush] ${kind}: target=${res.targetUsers} delivered=${res.deliveredUsers} skipped=${JSON.stringify(skipped)}`);
  return { ...res, skipped };
}

module.exports = { MESSAGES, runScheduled, deliver, deliveredUpdate };
