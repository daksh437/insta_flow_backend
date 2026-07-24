/**
 * Daily Viral Drop API — read-only. No AI calls here; only returns stored today drop.
 */

const express = require('express');
const {
  getTodayDrop,
  generateDailyDrop,
  generatePersonalizedDrop,
} = require('../services/dailyDropGenerator');

const router = express.Router();

/**
 * GET /daily-drop/today
 * Connected creators get a PERSONALIZED drop (built from their Instagram
 * themes/hashtags/best-times, cached per user per day). Everyone else gets the
 * global drop, which is self-healing: if the cron hasn't run (or the store was
 * wiped by a Render restart) it generates once on demand and mirrors into
 * Firestore for the app's direct read.
 */
router.get('/today', async (req, res) => {
  try {
    const uid = (req.headers['x-user-uid'] || req.headers['x-user-id'] || '')
      .toString()
      .trim();

    // Personalized for connected users; returns null (→ global) if not connected.
    if (uid) {
      const personalized = await generatePersonalizedDrop(uid);
      if (personalized) {
        return res.json({ success: true, ok: true, drop: personalized, personalized: true });
      }
    }

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
