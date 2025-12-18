const express = require('express');

const {
  generateCaptions,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateReelsScript
} = require('../controllers/geminiController');

const router = express.Router();

/**
 * AI Generation Endpoints
 * NOTE: All endpoints are synchronous (no job/status system)
 */

// Captions
router.post('/captions', generateCaptions);

// Image based captions
router.post('/image-captions', generateImageCaptions);
router.post('/caption-from-media', generateCaptionFromMedia);

// Calendar & Strategy
router.post('/calendar', generateCalendar);
router.post('/strategy', generateStrategy);
router.post('/analyze', analyzeNiche);

// 🎬 Reels Script (MAIN FEATURE)
router.post('/reels-script', generateReelsScript);

module.exports = router;

