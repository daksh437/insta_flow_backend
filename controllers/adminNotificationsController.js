const { getAdmin, getDb } = require('../utils/firestoreAdmin');
const policy = require('../services/notificationPolicy');
const marketingPush = require('../services/marketingPush');

// Any instant outside 10 PM–9 AM IST (noon IST), so a preview made at night
// still shows who would be eligible once quiet hours end.
const QUIET_FREE_PROBE = Date.UTC(2026, 0, 1, 6, 30);

/** Replaceable in tests. */
const clock = { now: () => new Date() };

const _rateStore = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 3;

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    const ms = v > 9999999999 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const num = Number(v);
    if (!Number.isNaN(num) && String(num) === v.trim()) {
      const ms = num > 9999999999 ? num : num * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function parsePayload(body = {}) {
  const segment = String(body.segment || '').toLowerCase();
  const inactiveDays = Number(body.inactiveDays || 7);
  const title = String(body.title || '').trim();
  const message = String(body.body || '').trim();
  const deepLink = String(body.deepLink || '').trim();
  const ctaLabel = String(body.ctaLabel || '').trim();
  return { segment, inactiveDays, title, message, deepLink, ctaLabel };
}

function validatePayload(payload, isPreview) {
  const allowedSegments = new Set(['trial', 'premium', 'inactive']);
  if (!allowedSegments.has(payload.segment)) return 'Invalid segment';
  if (payload.segment === 'inactive' && (![1, 3, 7, 14, 30].includes(payload.inactiveDays))) {
    return 'Invalid inactiveDays';
  }
  if (!isPreview) {
    if (!payload.title || payload.title.length > 120) return 'Invalid title';
    if (!payload.message || payload.message.length > 400) return 'Invalid body';
    if (payload.deepLink.length > 100) return 'Invalid deepLink';
    if (payload.ctaLabel.length > 40) return 'Invalid ctaLabel';
  }
  return null;
}

function getTokens(userData) {
  const arr = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  const one = typeof userData.fcmToken === 'string' ? [userData.fcmToken] : [];
  const out = [...arr, ...one]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  return Array.from(new Set(out));
}

function pickTrialEnd(d) {
  return toDate(d.trialEndDate) || toDate(d.trialEnd) || toDate(d.trialExpiry);
}

function pickLastActive(d) {
  return toDate(d.lastActiveAt) || toDate(d.lastActive) || toDate(d.lastSeen) || toDate(d.lastUpdated);
}

function isInSegment(d, payload, now) {
  if (payload.segment === 'premium') {
    const expiry = toDate(d.premiumExpiry);
    return d.isPremium === true && expiry && expiry > now;
  }
  if (payload.segment === 'trial') {
    const trialEnd = pickTrialEnd(d);
    return !!(trialEnd && trialEnd > now);
  }
  const inactiveCutoff = new Date(now.getTime() - payload.inactiveDays * 24 * 60 * 60 * 1000);
  const lastActive = pickLastActive(d);
  return !!(lastActive && lastActive < inactiveCutoff);
}

/**
 * Campaign audience: users in the segment whom the marketing policy allows
 * right now (not opted out of "reminders", under the 4-per-7-days cap, with a
 * token). policySkipped counts the rest by reason.
 */
async function buildAudience(payload, now = clock.now()) {
  const db = getDb();
  const snap = await db.collection('users').limit(2000).get();
  const users = [];
  const allTokens = new Set();
  const policySkipped = {};
  let skipped = 0;

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (!isInSegment(d, payload, now)) continue;
    // Quiet hours are checked once for the whole send, not per user.
    const decision = policy.canSendMarketing(d, policy.isQuietHour(now) ? new Date(QUIET_FREE_PROBE) : now, 'reminders');
    if (!decision.ok) {
      skipped += 1;
      policySkipped[decision.reason] = (policySkipped[decision.reason] || 0) + 1;
      continue;
    }
    getTokens(d).forEach((t) => allTokens.add(t));
    users.push({ uid: doc.id, user: d });
  }

  return {
    users,
    targetUsers: users.length,
    targetTokens: allTokens.size,
    skippedCount: skipped,
    policySkipped,
    quietHours: policy.isQuietHour(now),
  };
}

function hitRateLimit(adminUid) {
  const now = Date.now();
  const arr = _rateStore.get(adminUid) || [];
  const filtered = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (filtered.length >= RATE_LIMIT) return true;
  filtered.push(now);
  _rateStore.set(adminUid, filtered);
  return false;
}

async function previewCampaign(req, res) {
  try {
    const payload = parsePayload(req.body);
    const err = validatePayload(payload, true);
    if (err) return res.status(400).json({ success: false, error: err });
    const audience = await buildAudience(payload);
    const { users, ...summary } = audience;
    return res.json({ success: true, ...summary });
  } catch (e) {
    console.error('[AdminNotify] preview failed', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

async function sendCampaign(req, res) {
  try {
    const adminUid = req.adminUid;
    if (hitRateLimit(adminUid)) {
      return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const payload = parsePayload(req.body);
    const err = validatePayload(payload, false);
    if (err) return res.status(400).json({ success: false, error: err });

    const admin = getAdmin();
    const db = getDb();
    if (!admin || !db) {
      return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
    }

    const startedAt = clock.now();
    if (policy.isQuietHour(startedAt)) {
      return res.status(400).json({
        success: false,
        error: 'QUIET_HOURS',
        message: 'No marketing pushes between 10 PM and 9 AM IST. Try again after 9 AM IST.',
      });
    }
    const campaignRef = db.collection('admin_notification_campaigns').doc();
    const audience = await buildAudience(payload, startedAt);

    await campaignRef.set({
      createdByUid: adminUid,
      segment: payload.segment,
      filters: { inactiveDays: payload.inactiveDays },
      title: payload.title,
      body: payload.message,
      deepLink: payload.deepLink || null,
      ctaLabel: payload.ctaLabel || null,
      targetUsers: audience.targetUsers,
      targetTokens: audience.targetTokens,
      skippedCount: audience.skippedCount,
      policySkipped: audience.policySkipped,
      successCount: 0,
      failureCount: 0,
      status: 'processing',
      sampleErrors: [],
      startedAt,
      createdAt: startedAt,
    });

    const sent = await marketingPush.deliver({
      recipients: audience.users,
      title: payload.title,
      body: payload.message,
      data: {
        ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
        ...(payload.ctaLabel ? { ctaLabel: payload.ctaLabel } : {}),
        segment: payload.segment,
      },
      kind: 'campaign',
      now: startedAt,
    });
    const { successCount, failureCount } = sent;
    const sampleErrors = [];

    const completedAt = new Date();
    await campaignRef.set(
      {
        successCount,
        failureCount,
        skippedCount: audience.skippedCount,
        sampleErrors,
        status: 'completed',
        completedAt,
      },
      { merge: true }
    );

    return res.json({
      success: true,
      campaignId: campaignRef.id,
      targetUsers: audience.targetUsers,
      targetTokens: audience.targetTokens,
      successCount,
      failureCount,
      skippedCount: audience.skippedCount,
    });
  } catch (e) {
    console.error('[AdminNotify] send failed', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

module.exports = {
  previewCampaign,
  sendCampaign,
  clock,
};
