/**
 * Daily Viral Drop API — read-only. No AI calls here; only returns stored today drop.
 */

const express = require('express');
const { getTodayDrop } = require('../services/dailyDropGenerator');

const router = express.Router();

/**
 * GET /daily-drop/today
 * Returns today's drop JSON from store. 404 if not yet generated.
 */
router.get('/today', (req, res) => {
  const drop = getTodayDrop();
  if (!drop) {
    return res.status(404).json({
      success: false,
      ok: false,
      error: 'Today\'s drop not yet generated. Try again later.',
    });
  }
  res.json({
    success: true,
    ok: true,
    drop,
  });
});

module.exports = router;
