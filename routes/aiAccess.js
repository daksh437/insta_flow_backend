/**
 * GET /check-ai-access — returns current AI access state for the user (no AI call).
 * Admin: POST /admin/set-premium, POST /admin/reset-credits (require x-admin-key).
 */

const express = require('express');
const { getDb } = require('../utils/firestoreAdmin');
const { getAiAccess, DAILY_CREDITS_FREE, setPremium, resetCredits, setPlanType, todayDateStr, logAiAccess } = require('../middleware/aiAccess');
const { requireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');
const { PLAN_CREDITS, PACK_CREDITS, FREE_GRANTS, REFERRAL_PURCHASE_BONUS_PCT } = require('../config/credits');
const creditService = require('../services/creditService');
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
    // No auto-grants here — signup bonus / daily login are claimed
    // explicitly from the Gift screen (routes/rewards.js), not silently on
    // app open or first AI call.
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
    return res.json({
      success: true,
      code,
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
    return res.json({
      success: true,
      message: `Linked! Your friend earns ${FREE_GRANTS.REFERRAL_INVITER} credits once you try an AI feature.`,
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
    return res.status(400).json({ success: false, ok: false, error: 'UNKNOWN_PRODUCT', message: 'Unknown productId' });
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
        let referredByUid = null;
        let alreadyGranted = false;
        await firestore.runTransaction(async (tx) => {
          const g = await tx.get(grantRef);
          if (g.exists) { alreadyGranted = true; return; }
          const uref = firestore.collection('users').doc(uid);
          const usnap = await tx.get(uref);
          const cur = usnap.exists && typeof usnap.data().credits === 'number' ? usnap.data().credits : 0;
          referredByUid = usnap.exists ? (usnap.data().referredByUid || null) : null;
          const balanceAfter = cur + amount;
          tx.set(uref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
          tx.set(grantRef, { uid, productId, amount, at: new Date() });
          creditService.recordTransactionInTx(tx, uid, {
            type: 'purchase',
            amount,
            balanceAfter,
            description: `Purchased ${productId}`,
            meta: { productId, purchaseToken },
          });
        });

        if (!alreadyGranted) {
          console.log(`[credits] purchase grant +${amount} to ${uid} (${productId})`);

          // Referral purchase bonus: whoever referred this buyer gets a cut
          // of the credits this purchase granted, every time the friend
          // buys — an ongoing incentive, not just a one-off. Idempotent by
          // its own grant doc so a retry never double-pays the referrer.
          if (referredByUid && referredByUid !== uid) {
            const bonus = Math.round(amount * REFERRAL_PURCHASE_BONUS_PCT);
            if (bonus > 0) {
              const refGrantId = crypto.createHash('sha256').update(`referral:${purchaseToken}:${productId}`).digest('hex');
              const refGrantRef = firestore.collection('credit_grants').doc(refGrantId);
              try {
                await firestore.runTransaction(async (tx) => {
                  const g = await tx.get(refGrantRef);
                  if (g.exists) return;
                  const rref = firestore.collection('users').doc(referredByUid);
                  const rsnap = await tx.get(rref);
                  const rcur = rsnap.exists && typeof rsnap.data().credits === 'number' ? rsnap.data().credits : 0;
                  const rbalanceAfter = rcur + bonus;
                  tx.set(rref, { credits: rbalanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
                  tx.set(refGrantRef, {
                    uid: referredByUid,
                    productId,
                    amount: bonus,
                    at: new Date(),
                    reason: 'referral_purchase_bonus',
                    referredUid: uid,
                  });
                  creditService.recordTransactionInTx(tx, referredByUid, {
                    type: 'referral_purchase_bonus',
                    amount: bonus,
                    balanceAfter: rbalanceAfter,
                    description: `Referral bonus — friend bought ${productId}`,
                    meta: { productId, referredUid: uid },
                  });
                  // Per-friend running total for the Refer & Earn breakdown list.
                  const admin = require('firebase-admin');
                  const referralRowRef = firestore.collection('users').doc(referredByUid).collection('referrals').doc(uid);
                  tx.set(referralRowRef, {
                    totalCreditsEarned: admin.firestore.FieldValue.increment(bonus),
                  }, { merge: true });
                });
                console.log(`[credits] referral purchase bonus +${bonus} to ${referredByUid} (from ${uid}'s ${productId})`);
              } catch (e) {
                console.warn('[credits] referral purchase bonus failed:', e.message);
              }
            }
          }
        }
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
