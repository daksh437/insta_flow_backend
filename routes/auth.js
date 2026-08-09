const express = require('express');
const {
  getAuthUrl,
  handleCallback,
  getStatus,
  redirectGoogleOAuth,
} = require('../controllers/authController');
const {
  instagramCallback,
  instagramStatus,
  instagramDeauthorize,
  instagramDataDeletion,
  instagramDeletionStatus,
} = require('../controllers/instagramAuthController');
const { requireAuth } = require('../middleware/verifyAuth');

const router = express.Router();

// OAuth redirects (browser navigation, no Authorization header possible) —
// left as-is; handleCallback derives uid from the signed `state` param, and
// redirectGoogleOAuth only kicks off the consent flow.
router.get('/google/callback', handleCallback);
router.get('/google', redirectGoogleOAuth);
router.get('/instagram/callback', instagramCallback);
router.get('/instagram/status', instagramStatus);

// Meta-required callbacks for the Instagram API with Instagram Login product
// (App Dashboard -> Instagram -> API setup with Instagram login). Meta calls
// these directly with a signed_request body — no auth header possible.
router.post('/instagram/deauthorize', instagramDeauthorize);
router.post('/instagram/data-deletion', instagramDataDeletion);
router.get('/instagram/deletion-status', instagramDeletionStatus);

// App-initiated calls — require a verified token.
router.get('/url', requireAuth, getAuthUrl);
router.get('/status', requireAuth, getStatus);

module.exports = router;
