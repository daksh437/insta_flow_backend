/**
 * GET /check-ai-access — returns current AI access state for the user (no AI call).
 * Admin: POST /admin/set-premium, POST /admin/reset-credits (require x-admin-key).
 */

const express = require('express');
const { getDb } = require('../utils/firestoreAdmin');
const { getAiAccess, DAILY_CREDITS_FREE, setPremium, resetCredits, setPlanType, todayDateStr, logAiAccess } = require('../middleware/aiAccess');
const { requireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');
const { PLAN_CREDITS, PACK_CREDITS } = require('../config/credits');
const crypto = require('crypto');

const router = express.Router();
const ADMIN_KEY = process.env.ADMIN_SECRET || process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
  const key = (req.headers['x-admin-key'] || req.headers['X-Admin-Key'] || req.body?.adminKey || req.query?.adminKey) || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, ok: false, error: 'FORBIDDEN', message: 'Invalid or missing admin key' });
  }
  next();
}

/** GET /debug/ai-usage/:uid — full computed access state, no increment. Admin-only (was unauthenticated, letting anyone enumerate any user's usage). */
router.get('/debug/ai-usage/:uid', requireAdmin, async (req, res) => {
  const uid = (req.params.uid || '').trim();
  if (!uid) {
    return res.status(400).json({ success: false, ok: false, error: 'Missing uid', message: 'Provide uid in path, e.g. /debug/ai-usage/USER_UID' });
  }
  try {
    const access = await getAiAccess(uid);
    const response = {
      success: true,
      ok: true,
      uid,
      allowed: access.allowed,
      planType: access.planType || 'free',
      trialDaysLeft: access.trialDaysLeft ?? 0,
      dailyLimit: access.dailyLimit ?? null,
      dailyUsed: access.dailyUsed ?? 0,
      creditsLeftToday: access.creditsLeftToday,
      resetAtUtc: access.resetAtUtc ?? null,
      error: access.error || null,
      message: access.error ? 'Daily AI limit reached. Upgrade for more.' : null,
      user: access.user ? {
        planType: access.user.planType,
        trialEndDate: access.user.trialEndDate != null ? String(access.user.trialEndDate) : null,
        trialEnd: access.user.trialEnd != null ? String(access.user.trialEnd) : null,
        dailyAiUsed: access.user.dailyAiUsed,
        dailyAiDate: access.user.dailyAiDate,
        totalAiUsed: access.user.totalAiUsed,
      } : null,
    };
    res.json(response);
  } catch (e) {
    console.error('[debug/ai-usage]', e);
    res.status(500).json({
      success: false,
      ok: false,
      uid,
      error: 'SERVER_ERROR',
      message: e.message || 'Failed to get AI usage state',
    });
  }
});

router.get('/check-ai-access', requireAuth, async (req, res) => {
  const uid = req.uid;
  try {
    const access = await getAiAccess(uid);
    const planType = access.planType;
    const trialEndDate = access.trialEndDate ?? null;
    const trialDaysLeft = access.trialDaysLeft != null ? access.trialDaysLeft : (planType === 'trial' ? 0 : null);

    if (planType === 'trial') {
      return res.json({
        success: true,
        ok: true,
        allowed: true,
        planType: 'trial',
        dailyUsed: 0,
        dailyLimit: null,
        trialDaysLeft: trialDaysLeft ?? 0,
        trialEndDate,
        resetAtUtc: null,
        error: null,
        message: null,
      });
    }
    if (planType === 'premium') {
      return res.json({
        success: true,
        ok: true,
        allowed: true,
        planType: 'premium',
        dailyUsed: null,
        dailyLimit: null,
        trialDaysLeft: null,
        trialEndDate: null,
        premiumExpiry: access.premiumExpiry ?? null,
        resetAtUtc: null,
        error: null,
        message: null,
      });
    }

    res.json({
      success: true,
      ok: true,
      allowed: access.allowed,
      planType: 'free',
      dailyUsed: access.dailyUsed,
      dailyLimit: access.dailyLimit,
      trialDaysLeft: null,
      trialEndDate: null,
      resetAtUtc: access.resetAtUtc ?? null,
      error: access.error ?? null,
      message: !access.allowed ? 'Daily AI limit reached. Upgrade for more.' : null,
    });
  } catch (e) {
    console.error('[check-ai-access]', e);
    res.status(500).json({
      success: false,
      ok: false,
      allowed: false,
      error: 'SERVER_ERROR',
      message: e.message || 'Failed to check access',
    });
  }
});

// ─── Referral (invite a friend → both get 5 days free premium) ──────────────
const REFERRAL_REWARD_DAYS = 5;
function genReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function grantDaysPremiumFields(currentExpiry, now, days) {
  const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const expiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    isPremium: true,
    planType: 'premium',
    subscriptionPlan: 'pro',
    premiumPlan: 'pro',
    premiumExpiry: expiry,
    premiumStartDate: now,
    premiumExpiryNotified: false,
    isTrialActive: false,
    lastPurchaseStatus: 'referral',
    lastUpdated: new Date(),
  };
}

/** GET /referral/code — this user's shareable referral code (created lazily). */
router.get('/referral/code', requireAuth, async (req, res) => {
  const uid = req.uid;
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
  try {
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    let code = snap.data()?.referralCode;
    if (!code) {
      code = genReferralCode();
      await ref.set({ referralCode: code }, { merge: true });
    }
    return res.json({
      success: true,
      code,
      referralCount: snap.data()?.referralCount || 0,
      alreadyRedeemed: !!snap.data()?.referredBy,
      rewardDays: REFERRAL_REWARD_DAYS,
    });
  } catch (e) {
    console.error('[referral/code]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

/** POST /referral/redeem — a new user redeems a friend's code; both get reward. */
router.post('/referral/redeem', requireAuth, strictLimiter, async (req, res) => {
  const uid = req.uid;
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ success: false, error: 'MISSING_CODE', message: 'Enter a referral code' });
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
  try {
    const meRef = db.collection('users').doc(uid);
    const me = await meRef.get();
    if (!me.exists) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (me.data()?.referredBy) {
      return res.status(400).json({ success: false, error: 'ALREADY_REDEEMED', message: 'You have already used a referral code.' });
    }
    if (me.data()?.referralCode === code) {
      return res.status(400).json({ success: false, error: 'SELF_REFERRAL', message: "You can't use your own code." });
    }
    const q = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (q.empty) return res.status(400).json({ success: false, error: 'INVALID_CODE', message: 'Invalid referral code.' });
    const referrer = q.docs[0];
    if (referrer.id === uid) {
      return res.status(400).json({ success: false, error: 'SELF_REFERRAL', message: "You can't refer yourself." });
    }
    const now = new Date();
    const toDateSafe = (v) => (v && v.toDate ? v.toDate() : null);
    // Reward both sides with 5 days premium (extends existing premium).
    await meRef.set({
      ...grantDaysPremiumFields(toDateSafe(me.data()?.premiumExpiry), now, REFERRAL_REWARD_DAYS),
      referredBy: code,
    }, { merge: true });
    const admin = require('firebase-admin');
    await referrer.ref.set({
      ...grantDaysPremiumFields(toDateSafe(referrer.data()?.premiumExpiry), now, REFERRAL_REWARD_DAYS),
      referralCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    return res.json({ success: true, rewardDays: REFERRAL_REWARD_DAYS, message: `You both got ${REFERRAL_REWARD_DAYS} days of Premium!` });
  } catch (e) {
    console.error('[referral/redeem]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

/**
 * POST /activate-premium — server-authoritative subscription activation.
 * Body: { purchaseToken, productId }. The client sends the Play purchase token
 * (never writes premium itself). We persist the receipt, then reuse getAiAccess
 * which verifies with Google Play, enforces one-account-per-token ownership, and
 * writes premiumExpiry. Returns the resulting plan so the gate can open.
 */
router.post('/activate-premium', requireAuth, strictLimiter, async (req, res) => {
  const uid = req.uid;
  const purchaseToken = (req.body?.purchaseToken || '').trim();
  const productId = (req.body?.productId || 'premium_monthly').trim();
  if (!purchaseToken) {
    return res.status(400).json({ success: false, ok: false, error: 'MISSING_TOKEN', message: 'purchaseToken is required' });
  }
  const firestore = getDb();
  if (!firestore) {
    return res.status(503).json({ success: false, ok: false, error: 'FIRESTORE_UNAVAILABLE' });
  }
  try {
    // Persist the receipt (server writes it — the client no longer touches premium fields).
    await firestore.collection('users').doc(uid).set({
      subscription: {
        productId,
        purchaseToken,
        purchaseTime: Date.now(),
        updatedAt: new Date(),
        platform: 'android',
      },
    }, { merge: true });

    // Reuse the single activation path: verify with Play + token ownership + set premiumExpiry.
    const access = await getAiAccess(uid);

    // Grant credits for the purchased plan/pack — idempotent by purchaseToken so
    // re-verification never double-grants. (Renewals handled on next activation.)
    try {
      const amount = PLAN_CREDITS[productId] || PACK_CREDITS[productId] || 0;
      if (amount > 0) {
        const grantId = crypto.createHash('sha256').update(`${purchaseToken}:${productId}`).digest('hex');
        const grantRef = firestore.collection('credit_grants').doc(grantId);
        await firestore.runTransaction(async (tx) => {
          const g = await tx.get(grantRef);
          if (g.exists) return;
          const uref = firestore.collection('users').doc(uid);
          const usnap = await tx.get(uref);
          const cur = usnap.exists && typeof usnap.data().credits === 'number' ? usnap.data().credits : 0;
          tx.set(uref, { credits: cur + amount, creditsUpdatedAt: new Date() }, { merge: true });
          tx.set(grantRef, { uid, productId, amount, at: new Date() });
        });
        console.log(`[credits] purchase grant +${amount} to ${uid} (${productId})`);
      }
    } catch (e) {
      console.warn('[credits] purchase grant failed:', e.message);
    }

    return res.json({
      success: true,
      ok: true,
      planType: access.planType || 'free',
      allowed: access.allowed === true,
      premiumExpiry: access.premiumExpiry ?? null,
      message: access.planType === 'premium' ? 'Premium activated' : 'Not activated (payment not verified as active)',
    });
  } catch (e) {
    console.error('[activate-premium]', e);
    return res.status(500).json({ success: false, ok: false, error: 'SERVER_ERROR', message: e.message || 'Activation failed' });
  }
});

// Admin: manual upgrade to premium
router.post('/admin/set-premium', requireAdmin, async (req, res) => {
  const uid = (req.body?.uid || req.query?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, ok: false, error: 'Missing uid', message: 'Provide uid in body or query' });
  try {
    const done = await setPremium(uid, true);
    return res.json({ success: done, ok: true, message: done ? 'User set to premium' : 'Update failed' });
  } catch (e) {
    return res.status(500).json({ success: false, ok: false, error: 'SERVER_ERROR', message: e.message });
  }
});

// Admin: reset daily credits / AI usage for a user (support/debug)
router.post('/admin/reset-credits', requireAdmin, async (req, res) => {
  const uid = (req.body?.uid || req.query?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, ok: false, error: 'Missing uid', message: 'Provide uid in body or query' });
  try {
    const done = await resetCredits(uid);
    return res.json({ success: done, ok: true, message: done ? 'Credits reset' : 'Update failed' });
  } catch (e) {
    return res.status(500).json({ success: false, ok: false, error: 'SERVER_ERROR', message: e.message });
  }
});

// Admin: set plan type (support/debug). Body: { uid, planType: "trial"|"free"|"premium" }
router.post('/admin/set-plan-type', requireAdmin, async (req, res) => {
  const uid = (req.body?.uid || req.query?.uid || '').trim();
  const planType = (req.body?.planType || req.query?.planType || '').toLowerCase();
  if (!uid) return res.status(400).json({ success: false, ok: false, error: 'Missing uid' });
  if (!['trial', 'free', 'premium'].includes(planType)) return res.status(400).json({ success: false, ok: false, error: 'Invalid planType', message: 'Use trial, free, or premium' });
  try {
    const done = await setPlanType(uid, planType);
    return res.json({ success: done, ok: true, message: done ? `Plan set to ${planType}` : 'Update failed' });
  } catch (e) {
    return res.status(500).json({ success: false, ok: false, error: 'SERVER_ERROR', message: e.message });
  }
});

/** POST /admin/debug-user-ai — returns raw Firestore AI fields for a user (verify live schema). */
function toIsoOrNull(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return String(v);
}
router.post('/admin/debug-user-ai', requireAdmin, async (req, res) => {
  const uid = (req.body?.uid || req.query?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, ok: false, error: 'Missing uid', message: 'Provide uid in body or query' });
  const firestore = getDb();
  if (!firestore) return res.status(503).json({ success: false, ok: false, error: 'FIRESTORE_UNAVAILABLE', message: 'Firestore not initialized' });
  try {
    const snap = await firestore.collection('users').doc(uid).get();
    const serverNow = new Date().toISOString();
    const todayUtc = todayDateStr();
    if (!snap.exists) {
      return res.json({
        success: true,
        ok: true,
        uid,
        exists: false,
        planType: null,
        trialStartDate: null,
        trialEndDate: null,
        dailyAiUsed: null,
        dailyAiDate: null,
        totalAiUsed: null,
        serverNow,
        todayUtc,
      });
    }
    const data = snap.data();
    res.json({
      success: true,
      ok: true,
      uid,
      exists: true,
      planType: data.planType ?? data.plan_type ?? null,
      trialStartDate: toIsoOrNull(data.trialStartDate || data.trialStart),
      trialEndDate: toIsoOrNull(data.trialEndDate || data.trialEnd),
      dailyAiUsed: typeof (data.dailyAiUsed ?? data.daily_ai_used) === 'number' ? (data.dailyAiUsed ?? data.daily_ai_used) : null,
      dailyAiDate: data.dailyAiDate ?? data.daily_ai_date ?? null,
      totalAiUsed: typeof (data.totalAiUsed ?? data.total_ai_used) === 'number' ? (data.totalAiUsed ?? data.total_ai_used) : null,
      serverNow,
      todayUtc,
    });
  } catch (e) {
    console.error('[admin/debug-user-ai]', e);
    res.status(500).json({ success: false, ok: false, uid, error: 'SERVER_ERROR', message: e.message });
  }
});

module.exports = router;
