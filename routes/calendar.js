const express = require('express');
const { createCalendarEvent } = require('../controllers/calendarController');
const { getStatus } = require('../controllers/authController');
const { requireAuth } = require('../middleware/verifyAuth');

const router = express.Router();

// These act on a specific user's Google Calendar, so gate behind a verified
// Firebase ID token — a spoofed uid header would let anyone read/write
// another user's calendar connection.
router.use(requireAuth);

router.get('/status', getStatus);
router.post('/create-event', createCalendarEvent);
router.post('/create', createCalendarEvent);

module.exports = router;

