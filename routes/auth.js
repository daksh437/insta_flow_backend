const express = require('express');
const { getAuthUrl, handleCallback, getStatus } = require('../controllers/authController');
const { instagramCallback, instagramStatus } = require('../controllers/instagramAuthController');

const router = express.Router();

router.get('/url', getAuthUrl);
router.get('/google/callback', handleCallback);
router.get('/status', getStatus);
router.get('/instagram/callback', instagramCallback);
router.get('/instagram/status', instagramStatus);

module.exports = router;
