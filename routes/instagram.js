const express = require('express');
const {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
  debugInstagramProfile,
} = require('../controllers/instagramController');

const router = express.Router();

router.post('/instagram-connect', connectInstagram);
router.get('/instagram-stats', getInstagramStats);
router.get('/instagram-debug-profile', debugInstagramProfile);
router.post('/instagram/media', createMedia);
router.post('/instagram/media/publish', publishMedia);
router.get('/instagram/insights', getInsights);

module.exports = router;
