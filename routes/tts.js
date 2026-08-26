const express = require('express');
const { synthesizeTts } = require('../controllers/ttsController');
const { requireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Text-to-Speech is billed by character against the project's Google Cloud
// account, so this route needs the same protection as the AI routes: a verified
// Firebase ID token (sets req.uid, which the controller charges credits to) and
// a tighter per-IP limiter than the global one, since a single caller can
// otherwise generate a lot of billable audio quickly.
router.post('/tts', requireAuth, strictLimiter, synthesizeTts);

module.exports = router;
