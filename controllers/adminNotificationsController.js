const { getAdmin, getDb } = require('../utils/firestoreAdmin');

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

async function buildAudience(payload) {
  const db = getDb();
  const now = new Date();
  const snap = await db.collection('users').limit(2000).get();
  const users = [];
  const allTokens = new Set();
  let skipped = 0;

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (!isInSegment(d, payload, now)) continue;
    const tokens = getTokens(d);
    if (tokens.length === 0) {
      skipped += 1;
    } else {
      tokens.forEach((t) => allTokens.add(t));
    }
    users.push({ uid: doc.id, tokens });
  }

  return {
    users,
    targetUsers: users.length,
    targetTokens: allTokens.size,
    skippedCount: skipped,
    tokens: Array.from(allTokens),
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
    return res.json({ success: true, ...audience });
  } catch (e) {
    console.error('[AdminNotify] preview failed', e.message);
    return res.status(500).json({ success: false, error: 'Something went wrong, try again' });
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
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

    const campaignRef = db.collection('admin_notification_campaigns').doc();
    const startedAt = new Date();
    const audience = await buildAudience(payload);

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
      successCount: 0,
      failureCount: 0,
      status: 'processing',
      sampleErrors: [],
      startedAt,
      createdAt: startedAt,
    });

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = new Set();
    const sampleErrors = [];
    const batches = chunk(audience.tokens, 500);

    for (const tokenBatch of batches) {
      if (tokenBatch.length === 0) continue;
      const message = {
        tokens: tokenBatch,
        notification: { title: payload.title, body: payload.message },
        data: {
          ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
          ...(payload.ctaLabel ? { ctaLabel: payload.ctaLabel } : {}),
          segment: payload.segment,
        },
      };

      const sender = admin.messaging().sendEachForMulticast
        ? admin.messaging().sendEachForMulticast.bind(admin.messaging())
        : admin.messaging().sendMulticast.bind(admin.messaging());

      const resp = await sender(message);
      successCount += Number(resp.successCount || 0);
      failureCount += Number(resp.failureCount || 0);

      (resp.responses || []).forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code || 'unknown';
        const msg = r.error?.message || 'send failed';
        if (sampleErrors.length < 20) sampleErrors.push({ code, message: msg });
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          invalidTokens.add(tokenBatch[idx]);
        }
      });
    }

    // Best-effort token cleanup.
    if (invalidTokens.size > 0) {
      const invalid = Array.from(invalidTokens);
      const usersSnap = await db.collection('users').where('fcmTokens', 'array-contains-any', invalid.slice(0, 10)).get().catch(() => null);
      if (usersSnap && !usersSnap.empty) {
        const batch = db.batch();
        usersSnap.docs.forEach((doc) => {
          const data = doc.data() || {};
          const existing = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
          const cleaned = existing.filter((t) => !invalid.includes(String(t)));
          batch.update(doc.ref, { fcmTokens: cleaned });
        });
        await batch.commit().catch(() => null);
      }
    }

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
};
