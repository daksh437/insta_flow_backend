const express = require('express');
const {
  getAuthUrl,
  handleCallback,
  getStatus,
  redirectGoogleOAuth,
} = require('../controllers/authController');
const { instagramCallback, instagramStatus } = require('../controllers/instagramAuthController');

const router = express.Router();

router.get('/google/callback', handleCallback);
router.get('/google', redirectGoogleOAuth);
router.get('/url', getAuthUrl);
router.get('/status', getStatus);
router.get('/instagram/callback', instagramCallback);
router.get('/instagram/status', instagramStatus);

module.exports = router;
