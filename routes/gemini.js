const express = require('express');

const {
  generateCaptions,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateReelsScript,
  generatePostIdeas,
  generateHashtags,
  generateBio,
  getJobStatus
} = require('../controllers/geminiController');

const router = express.Router();

// AI Generation Endpoints (all return jobId immediately, non-blocking)
router.post('/captions', generateCaptions);
router.post('/image-captions', generateImageCaptions);
router.post('/caption-from-media', generateCaptionFromMedia);
router.post('/calendar', generateCalendar);
router.post('/strategy', generateStrategy);
router.post('/analyze', analyzeNiche);
router.post('/reels-script', generateReelsScript);
router.post('/post-ideas', generatePostIdeas);
router.post('/hashtags', generateHashtags);
router.post('/bio', generateBio);

// Unified Job Status Endpoint (for all AI jobs)
router.get('/job-status/:jobId', getJobStatus);

module.exports = router;

