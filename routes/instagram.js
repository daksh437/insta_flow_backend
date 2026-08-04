const express = require('express');
const {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
} = require('../controllers/instagramController');
const { requireAuth } = require('../middleware/verifyAuth');

const router = express.Router();

// All routes here act on a specific user's connected Instagram account
// (including publishing posts), so every one of them must be gated behind a
// verified Firebase ID token — never trust a client-supplied uid header.
router.use(requireAuth);

router.post('/instagram-connect', connectInstagram);
router.get('/instagram-stats', getInstagramStats);
router.post('/instagram/media', createMedia);
router.post('/instagram/media/publish', publishMedia);
router.get('/instagram/insights', getInsights);

module.exports = router;
