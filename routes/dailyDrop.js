/**
 * Daily Viral Drop API — opt-in and credit-metered.
 *
 * This used to be an unauthenticated GET that generated a personalised drop
 * (a real Gemini call) for whatever uid the caller put in a header, free of
 * charge. That made it both an open cost hole and the single largest source of
 * uncharged AI spend in the app.
 *
 * Now:
 *   - the route requires a verified Firebase ID token;
 *   - a user only gets a drop if they switched the feature ON (default OFF, so
 *     users who never opt in cost nothing at all);
 *   - the first fetch of each UTC day costs CREDIT_COSTS.daily_drop credits.
 *     Re-reading the same day's cached drop is free — the spend is idempotent
 *     on `daily-drop:<dateKey>`.
 */

const express = require('express');
const {
  getTodayDrop,
  generateDailyDrop,
  generatePersonalizedDrop,
} = require('../services/dailyDropGenerator');
const { requireAuth } = require('../middleware/verifyAuth');
const { getDb } = require('../utils/firestoreAdmin');
const creditService = require('../services/creditService');
const { CREDIT_COSTS } = require('../config/credits');

const router = express.Router();

const DROP_COST = CREDIT_COSTS.daily_drop;

/** Server-side UTC date key, so a client clock can't buy two drops in a day. */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read the user's opt-in flag. Defaults to OFF: the feature costs real money
 * per user per day, so it must be chosen, not inherited.
 */
async function isEnabled(uid) {
  const db = getDb();
  if (!db) return false;
  try {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists && snap.data().dailyDropEnabled === true;
  } catch (e) {
    console.warn('[DailyDrop] preference read failed:', e.message);
    return false;
  }
}

/** GET /daily-drop/preference — current toggle state, for rendering the switch. */
router.get('/preference', requireAuth, async (req, res) => {
  const enabled = await isEnabled(req.uid);
  res.json({ success: true, ok: true, enabled, cost: DROP_COST });
});

/** POST /daily-drop/preference — { enabled: boolean }. Turns the feature on/off. */
router.post('/preference', requireAuth, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({
      success: false, ok: false, error: 'INVALID_BODY', message: 'enabled must be a boolean',
    });
  }
  const db = getDb();
  if (!db) {
    return res.status(503).json({ success: false, ok: false, error: 'FIRESTORE_UNAVAILABLE' });
  }
  const enabled = req.body.enabled;
  try {
    await db.collection('users').doc(req.uid).set(
      { dailyDropEnabled: enabled, dailyDropEnabledAt: new Date() },
      { merge: true }
    );
    console.log(`[DailyDrop] preference uid=${req.uid} enabled=${enabled}`);
    return res.json({ success: true, ok: true, enabled, cost: DROP_COST });
  } catch (e) {
    console.error('[DailyDrop] preference write failed:', e.message);
    return res.status(500).json({ success: false, ok: false, error: 'PREFERENCE_WRITE_FAILED' });
  }
});

/**
 * GET /daily-drop/today
 *
 * Opted-in users are charged once per UTC day, then get a personalised drop if
 * their Instagram is connected, otherwise the shared global drop. Users who
 * have not opted in get `enabled: false` and no generation happens for them.
 */
router.get('/today', requireAuth, async (req, res) => {
  const uid = req.uid;

  if (!(await isEnabled(uid))) {
    return res.json({
      success: true,
      ok: true,
      enabled: false,
      drop: null,
      cost: DROP_COST,
      message: 'Daily Viral Drop is off. Turn it on to get today\'s drop.',
    });
  }

  // Charge BEFORE generating, atomically. The idempotency key is the UTC day,
  // so today's later fetches are free, and two concurrent first-fetches cannot
  // both slip through the way a read-then-write balance check would.
  let charged;
  try {
    charged = await creditService.spend(
      uid,
      DROP_COST,
      `daily-drop:${todayKey()}`,
      'Daily Viral Drop'
    );
  } catch (e) {
    console.error('[DailyDrop] spend failed:', e.message);
    return res.status(500).json({ success: false, ok: false, error: 'CREDIT_SPEND_FAILED' });
  }

  if (!charged) {
    const balance = await creditService.getBalance(uid);
    return res.status(403).json({
      success: false,
      ok: false,
      enabled: true,
      error: 'INSUFFICIENT_CREDITS',
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits for today\'s drop',
      balance,
      cost: DROP_COST,
    });
  }

  try {
    // Personalised for connected creators; null → fall back to the global drop,
    // which the cron generates once for everyone.
    const personalized = await generatePersonalizedDrop(uid);
    if (personalized) {
      return res.json({ success: true, ok: true, enabled: true, drop: personalized, personalized: true });
    }

    let drop = getTodayDrop();
    if (!drop) {
      drop = await generateDailyDrop();
    }
    if (!drop) {
      // Already charged for the day; the key makes a retry free, so the user
      // is not billed again when the drop becomes available.
      return res.status(404).json({
        success: false,
        ok: false,
        enabled: true,
        error: 'Today\'s drop not available yet. Try again later.',
      });
    }
    res.json({ success: true, ok: true, enabled: true, drop });
  } catch (err) {
    console.error('[DailyDrop] today failed:', err.message);
    res.status(500).json({ success: false, ok: false, error: err.message });
  }
});

module.exports = router;
