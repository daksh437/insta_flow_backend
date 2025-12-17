const express = require('express');
const { getAuthUrl, handleCallback, getStatus } = require('../controllers/authController');

const router = express.Router();

router.get('/url', getAuthUrl);
router.get('/callback', handleCallback);
router.get('/status', getStatus);

module.exports = router;

