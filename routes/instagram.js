const express = require('express');
const {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
} = require('../controllers/instagramController');
const { softRequireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// TEMPORARY: softRequireAuth (not requireAuth) — the currently-live app build
// never sent an Authorization token on these routes, only x-user-uid, so a
// hard requirement 401s every existing install until they update. Switch
// back to requireAuth once the fixed build has rolled out. See
// middleware/verifyAuth.js for details.
router.use(softRequireAuth);

router.post('/instagram-connect', connectInstagram);
router.get('/instagram-stats', getInstagramStats);
router.post('/instagram/media', strictLimiter, createMedia);
router.post('/instagram/media/publish', strictLimiter, publishMedia);
router.get('/instagram/insights', getInsights);

module.exports = router;
