const express = require('express');
const { generateCaptions, generateCalendar, generateStrategy, analyzeNiche, generateImageCaptions, generateCaptionFromMedia, generateReelsScript, getReelsScriptStatus } = require('../controllers/geminiController');

const router = express.Router();

router.post('/captions', generateCaptions);
router.post('/image-captions', generateImageCaptions);
router.post('/caption-from-media', generateCaptionFromMedia);
router.post('/calendar', generateCalendar);
router.post('/strategy', generateStrategy);
router.post('/analyze', analyzeNiche);
router.post('/reels-script', generateReelsScript);
router.get('/reels-script/status', getReelsScriptStatus);

module.exports = router;

