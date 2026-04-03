const express = require('express');
const { getAuthUrl, handleCallback, getStatus } = require('../controllers/authController');
const { facebookOAuthCallback } = require('../controllers/facebookOAuthController');

const router = express.Router();

router.get('/url', getAuthUrl);
// Facebook / Meta Login redirect_uri (log code, return simple HTML)
router.get('/callback', facebookOAuthCallback);
// Google Calendar OAuth (token exchange) — set GOOGLE_REDIRECT_URI to .../auth/google/callback
router.get('/google/callback', handleCallback);
router.get('/status', getStatus);

module.exports = router;

