/**
 * GET  /rewards/status                — claim status for the Gift screen
 * POST /rewards/claim-signup          — one-time signup bonus
 * POST /rewards/claim-daily           — once per UTC day
 * POST /rewards/claim-instagram-follow — one-time, honor system
 * POST /rewards/claim-youtube-subscribe — one-time, honor system
 * GET  /rewards/history               — paginated credit ledger (bank-statement style)
 *
 * All grants used to be silent (auto-run on the first AI call or app open),
 * which made a brand-new user's AI generation look "free with no credits"
 * even though a grant secretly happened first. Now every grant requires an
 * explicit user action from the in-app Gift screen, so credits — and their
 * absence — are always visible and intentional.
 */

const express = require('express');
const { getDb } = require('../utils/firestoreAdmin');
const { requireAuth } = require('../middleware/verifyAuth');
const creditService = require('../services/creditService');
const { FREE_GRANTS } = require('../config/credits');
const cohort = require('../services/cohort');
const entitlement = require('../services/entitlement');

const router = express.Router();

/**
 * Which free rewards this user may claim. Everyone outside the hard-paywall
 * cohort (existing users, and new signups still on an old app version): all
 * of them, as before. Hard-paywall users get no free credits: no welcome
 * gift, no daily credits; Instagram/YouTube only with an active entitlement.
 */
async function eligibility(req, userDoc) {
  const uid = req.uid;
  if (!(await cohort.isHardPaywallUser(uid, { versionCode: cohort.versionFromReq(req), userDoc, fromClient: true }))) {
    return { newUser: false, signup: true, daily: true, instagram: true, youtube: true, referral: true };
  }
  const entitled = entitlement.isActive(userDoc);
  return { newUser: true, signup: false, daily: false, instagram: entitled, youtube: entitled, referral: false };
}

async function loadUserDoc(uid) {
  const db = getDb();
  const snap = db ? await db.collection('users').doc(uid).get() : null;
  return snap && snap.exists ? snap.data() : null;
}

/** Wraps a claim handler: 403 NOT_ELIGIBLE when the user may not claim [reward]. */
function eligibleFor(reward) {
  return async (req, res, next) => {
    try {
      const e = await eligibility(req, await loadUserDoc(req.uid));
      if (!e[reward]) {
        return res.status(403).json({ success: false, granted: false, error: 'NOT_ELIGIBLE', message: 'This reward is not available on your account.' });
      }
      return next();
    } catch (err) {
      console.error('[rewards] eligibility check failed:', err.message);
      return res.status(500).json({ success: false, error: 'SERVER_ERROR' });
    }
  };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/status', requireAuth, async (req, res) => {
  const uid = req.uid;
  const db = getDb();
  if (!db) return res.status(503).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
  try {
    const snap = await db.collection('users').doc(uid).get();
    const d = snap.exists ? snap.data() : {};
    const e = await eligibility(req, snap.exists ? d : null);
    return res.json({
      success: true,
      // The app hides rewards whose eligible flag is false.
      eligible: {
        signupBonus: e.signup,
        dailyLogin: e.daily,
        instagramFollow: e.instagram,
        youtubeSubscribe: e.youtube,
        referral: e.referral, // Refer & Earn (hidden in the app when false)
      },
      credits: typeof d.credits === 'number' ? d.credits : 0,
      signupBonus: { claimed: d.creditsSignupBonusGranted === true, amount: FREE_GRANTS.NEW_USER_BONUS },
      dailyLogin: { claimed: d.creditsDailyDate === todayUtc(), amount: FREE_GRANTS.DAILY_LOGIN },
      instagramFollow: { claimed: d.instagramFollowClaimed === true, amount: FREE_GRANTS.INSTAGRAM_FOLLOW },
      youtubeSubscribe: { claimed: d.youtubeSubscribeClaimed === true, amount: FREE_GRANTS.YOUTUBE_SUBSCRIBE },
    });
  } catch (e) {
    console.error('[rewards/status]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

router.post('/claim-signup', requireAuth, eligibleFor('signup'), async (req, res) => {
  const granted = await creditService.ensureSignupBonus(req.uid);
  return res.json({ success: true, granted, amount: FREE_GRANTS.NEW_USER_BONUS });
});

router.post('/claim-daily', requireAuth, eligibleFor('daily'), async (req, res) => {
  const granted = await creditService.grantDailyLoginIfDue(req.uid);
  return res.json({ success: true, granted, amount: FREE_GRANTS.DAILY_LOGIN });
});

router.post('/claim-instagram-follow', requireAuth, eligibleFor('instagram'), async (req, res) => {
  const granted = await creditService.claimInstagramFollow(req.uid);
  return res.json({ success: true, granted, amount: FREE_GRANTS.INSTAGRAM_FOLLOW });
});

router.post('/claim-youtube-subscribe', requireAuth, eligibleFor('youtube'), async (req, res) => {
  const granted = await creditService.claimYoutubeSubscribe(req.uid);
  return res.json({ success: true, granted, amount: FREE_GRANTS.YOUTUBE_SUBSCRIBE });
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined;
    const items = await creditService.getHistory(req.uid, { limit, beforeId });
    return res.json({
      success: true,
      items: items.map((it) => ({
        id: it.id,
        type: it.type,
        amount: it.amount,
        balanceAfter: it.balanceAfter,
        description: it.description,
        at: it.at && typeof it.at.toDate === 'function' ? it.at.toDate().toISOString() : null,
      })),
      hasMore: items.length === limit,
    });
  } catch (e) {
    console.error('[rewards/history]', e);
    return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: e.message });
  }
});

module.exports = router;
