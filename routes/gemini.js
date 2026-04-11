const express = require('express');
const { requireAiAccess, wrapAiHandler } = require('../middleware/aiAccess');
const { AI_AUDIT_TAG } = require('../scripts/auditAiRoutes');

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
  generateHooks,
  generateCommentReply,
  generateTrends,
  generateCarousel,
  getJobStatus
} = require('../controllers/geminiController');

const { fullAssist, viralCaption, postAnalyze } = require('../controllers/aiGrowthController');

const router = express.Router();

// Job status polling (no AI access check)
router.get('/job-status/:jobId', getJobStatus);

// All POST AI endpoints require access check (sets req._aiEndpoint for logging)
const aiAccessMiddleware = (req, res, next) => {
  if (req.method === 'GET') return next();
  req._aiEndpoint = req.path && req.path !== '/' ? `/ai${req.path}` : req.originalUrl?.split('?')[0] || '/ai';
  requireAiAccess(req, res, next);
};
aiAccessMiddleware._aiAuditTag = AI_AUDIT_TAG;
router.use(aiAccessMiddleware);

// AI Generation Endpoints (all wrapped with wrapAiHandler — assert req.aiAccessAllowed before run)
router.post('/captions', wrapAiHandler(generateCaptions));
router.post('/image-captions', wrapAiHandler(generateImageCaptions));
router.post('/caption-from-media', wrapAiHandler(generateCaptionFromMedia));
router.post('/calendar', wrapAiHandler(generateCalendar));
router.post('/strategy', wrapAiHandler(generateStrategy));
router.post('/analyze', wrapAiHandler(analyzeNiche));
router.post('/reels-script', wrapAiHandler(generateReelsScript));
router.post('/post-ideas', wrapAiHandler(generatePostIdeas));
router.post('/hashtags', wrapAiHandler(generateHashtags));
router.post('/bio', wrapAiHandler(generateBio));
router.post('/hooks', wrapAiHandler(generateHooks));
router.post('/comment-reply', wrapAiHandler(generateCommentReply));
router.post('/trends', wrapAiHandler(generateTrends));
router.post('/carousel', wrapAiHandler(generateCarousel));

/** Instagram growth pack: full pipeline, viral caption, post insights */
router.post('/full-assist', wrapAiHandler(fullAssist));
router.post('/caption', wrapAiHandler(viralCaption));
router.post('/analyze-post', wrapAiHandler(postAnalyze));

module.exports = router;

