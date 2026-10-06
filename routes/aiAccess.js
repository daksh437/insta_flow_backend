/**
 * GET /check-ai-access — returns current AI access state for the user (no AI call).
 * Admin: POST /admin/set-premium, POST /admin/reset-credits (require x-admin-key).
 */

const express = require('express');
const cohort = require('../services/cohort');
const { getDb } = require('../utils/firestoreAdmin');
const { getAiAccess, DAILY_CREDITS_FREE, setPremium, resetCredits, setPlanType, todayDateStr, logAiAccess } = require('../middleware/aiAccess');
const { requireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');
const { PLAN_CREDITS, PACK_CREDITS, FREE_GRANTS, REFERRAL_PURCHASE_BONUS_PCT } = require('../config/credits');
const purchaseGrant = require('../services/purchaseGrant');
const creditService = require('../services/creditService');

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
    // No auto-grants here — signup bonus / daily login are claimed
    // explicitly from the Gift screen (routes/rewards.js), not silently on
    // app open or first AI call.
    const access = await getAiAccess(uid, { versionCode: cohort.versionFromReq(req), fromClient: true });
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

// ─── Referral (invite a friend → referrer earns credits from real activity) ──
// Redeeming a code just LINKS the two accounts — no instant reward for
// either side. The referrer earns credits from what the friend actually
// does afterward:
//   1. Friend's first successful AI generation → referrer gets
//      FREE_GRANTS.REFERRAL_INVITER credits (see recordAiUsage in
//      middleware/aiAccess.js), capped at FREE_GRANTS.REFERRAL_MAX
//      rewarded referrals per referrer (anti-fake-account abuse).
//   2. Every verified purchase (plan or pack) the friend makes → referrer
//      gets REFERRAL_PURCHASE_BONUS_PCT of the credits that purchase
//      granted (see /activate-premium below). Not capped — it's tied to
//      real revenue, not signups.
function genReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
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
    // Hard-paywall users never earn referral credits: the app hides Refer & Earn.
    const rewardsEligible = !(await cohort.isHardPaywallUser(uid, {
      versionCode: cohort.versionFromReq(req),
      userDoc: snap.exists ? snap.data() : null,
      fromClient: true,
    }));
    return res.json({
      success: true,
      code,
      rewardsEligible,
      referralCount: snap.data()?.referralCount || 0,
      alreadyRedeemed: !!snap.data()?.referredBy,
      aiUseReward: FREE_GRANTS.REFERRAL_INVITER,
      purchaseBonusPct: REFERRAL_PURCHASE_BONUS_PCT,
    });
  } catch (e) {
    console.error('[referral/code]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

/** POST /referral/redeem — a new user links themselves to a friend's code. No reward yet — see above. */
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
    const admin = require('firebase-admin');
    const now = admin.firestore.FieldValue.serverTimestamp();
    await meRef.set({
      referredBy: code,
      referredByUid: referrer.id,
      referredAt: now,
    }, { merge: true });
    await referrer.ref.set({
      referralCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    // Per-friend row for the Refer & Earn screen's breakdown list — created
    // now (0 earned so far) so the friend shows up immediately, then
    // totalCreditsEarned is incremented alongside each reward below.
    await referrer.ref.collection('referrals').doc(uid).set({
      referredUid: uid,
      referredEmail: me.data()?.email || '',
      joinedAt: now,
      totalCreditsEarned: 0,
    }, { merge: true });
    // No credit promise when either side is in the hard-paywall cohort (no
    // referral rewards there); legacy referrals keep the original message.
    const noRewards =
      (await cohort.isHardPaywallUser(uid, { versionCode: cohort.versionFromReq(req), userDoc: me.data(), fromClient: true })) ||
      (await cohort.isHardPaywallUser(referrer.id, { userDoc: referrer.data() }));
    return res.json({
      success: true,
      message: noRewards
        ? 'Linked! Thanks for joining InstaFlow through a friend.'
        : `Linked! Your friend earns ${FREE_GRANTS.REFERRAL_INVITER} credits once you try an AI feature.`,
    });
  } catch (e) {
    console.error('[referral/redeem]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

/** GET /referral/my-referrals — list of friends this user referred, with total credits earned from each. */
router.get('/referral/my-referrals', requireAuth, async (req, res) => {
  const uid = req.uid;
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
  try {
    const snap = await db
      .collection('users')
      .doc(uid)
      .collection('referrals')
      .orderBy('totalCreditsEarned', 'desc')
      .get();
    const items = snap.docs.map((d) => {
      const data = d.data();
      return {
        referredUid: data.referredUid || d.id,
        referredEmail: data.referredEmail || '',
        totalCreditsEarned: typeof data.totalCreditsEarned === 'number' ? data.totalCreditsEarned : 0,
        joinedAt: data.joinedAt && typeof data.joinedAt.toDate === 'function' ? data.joinedAt.toDate().toISOString() : null,
      };
    });
    return res.json({ success: true, items });
  } catch (e) {
    console.error('[referral/my-referrals]', e);
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
  // No default: this used to fall back to 'premium_monthly', so a client that
  // omitted productId silently claimed a premium subscription. The caller must
  // name the product it actually bought.
  const productId = (req.body?.productId || '').trim();
  if (!purchaseToken) {
    return res.status(400).json({ success: false, ok: false, error: 'MISSING_TOKEN', message: 'purchaseToken is required' });
  }
  if (!productId) {
    return res.status(400).json({ success: false, ok: false, error: 'MISSING_PRODUCT_ID', message: 'productId is required' });
  }
  if (!PLAN_CREDITS[productId] && !PACK_CREDITS[productId]) {
    // A retired premium_* subscription is a REAL receipt, not a bad request:
    // Google Play restores it to the client on every launch, so 400-ing it made
    // the app throw on each start. It simply no longer grants anything — answer
    // calmly with the plan the user actually has.
    if (/^premium/.test(productId)) {
      console.log(`[activate-premium] retired product ${productId} uid=${uid} — no premium granted`);
      return res.json({
        success: true,
        ok: true,
        planType: 'free',
        retired: true,
        message: 'This subscription is no longer offered. Credits are the current plan.',
      });
    }
    return res.status(400).json({ success: false, ok: false, error: 'UNKNOWN_PRODUCT', message: 'Unknown productId' });
  }
  const firestore = getDb();
  if (!firestore) {
    return res.status(503).json({ success: false, ok: false, error: 'FIRESTORE_UNAVAILABLE' });
  }
  try {
    // Credits are granted ONLY for a purchase Google Play verifies
    // (services/purchaseGrant.js). No receipt fallback.
    const result = await purchaseGrant.verifyAndGrant({ uid, productId, purchaseToken });

    if (result.status === 'invalid') {
      return res.status(402).json({
        success: false,
        ok: false,
        error: 'VERIFICATION_FAILED',
        message: 'Google Play could not verify this purchase.',
      });
    }
    if (result.status === 'pending') {
      // Play API unreachable: the receipt is queued and retried by a cron.
      return res.status(503).json({
        success: false,
        ok: false,
        error: 'VERIFICATION_PENDING',
        message: 'Purchase received. Credits will appear once Google Play confirms it.',
      });
    }

    // Verified: keep the receipt on the user doc (server-written).
    await firestore.collection('users').doc(uid).set({
      subscription: {
        productId,
        purchaseToken,
        purchaseTime: Date.now(),
        updatedAt: new Date(),
        platform: 'android',
        verified: true,
      },
    }, { merge: true });

    const access = await getAiAccess(uid, { versionCode: cohort.versionFromReq(req), fromClient: true });
    return res.json({
      success: true,
      ok: true,
      granted: result.status === 'granted',
      credits: result.amount,
      // The app logs trial_start once per trial order (deduped on orderId).
      isTrial: result.isTrial === true,
      orderId: result.orderId || null,
      planType: access.planType || 'free',
      allowed: access.allowed === true,
      premiumExpiry: access.premiumExpiry ?? null,
      message: result.status === 'granted' ? 'Credits added' : 'Purchase already applied',
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
