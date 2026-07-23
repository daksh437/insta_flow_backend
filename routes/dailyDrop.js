/**
 * Daily Viral Drop API — read-only. No AI calls here; only returns stored today drop.
 */

const express = require('express');
const { getTodayDrop, generateDailyDrop } = require('../services/dailyDropGenerator');

const router = express.Router();

/**
 * GET /daily-drop/today
 * Returns today's drop. Self-healing: if the cron hasn't run yet (or the store
 * was wiped by a Render restart), generate once on demand. Generation is
 * idempotent per day (keyed by date) and also mirrors into Firestore, so the
 * Flutter app's direct read is populated. One Gemini call per day at most.
 */
router.get('/today', async (req, res) => {
  try {
    let drop = getTodayDrop();
    if (!drop) {
      drop = await generateDailyDrop();
    }
    if (!drop) {
      return res.status(404).json({
        success: false,
        ok: false,
        error: 'Today\'s drop not available yet. Try again later.',
      });
    }
    res.json({ success: true, ok: true, drop });
  } catch (err) {
    res.status(500).json({ success: false, ok: false, error: err.message });
  }
});

module.exports = router;
