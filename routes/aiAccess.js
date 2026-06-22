/**
 * GET /check-ai-access — returns current AI access state for the user (no AI call).
 * Admin: POST /admin/set-premium, POST /admin/reset-credits (require x-admin-key).
 */

const express = require('express');
const { getDb } = require('../utils/firestoreAdmin');
const { getAiAccess, DAILY_CREDITS_FREE, setPremium, resetCredits, setPlanType, todayDateStr, logAiAccess } = require('../middleware/aiAccess');

const router = express.Router();
const ADMIN_KEY = process.env.ADMIN_SECRET || process.env.ADMIN_KEY || '';

function requireAdmin(req, res, next) {
  const key = (req.headers['x-admin-key'] || req.headers['X-Admin-Key'] || req.body?.adminKey || req.query?.adminKey) || '';
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, ok: false, error: 'FORBIDDEN', message: 'Invalid or missing admin key' });
  }
  next();
}

/** GET /debug/ai-usage/:uid — full computed access state, no increment. Visibility only. */
router.get('/debug/ai-usage/:uid', async (req, res) => {
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

router.get('/check-ai-access', async (req, res) => {
  const uid = (req.headers['x-user-uid'] || req.headers['X-User-UID'])?.trim();
  if (!uid) {
    return res.status(401).json({
      success: false,
      ok: false,
      allowed: false,
      error: 'UNAUTHORIZED',
      message: 'Missing x-user-uid header',
    });
  }
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
