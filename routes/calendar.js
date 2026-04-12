const express = require('express');
const { createCalendarEvent } = require('../controllers/calendarController');
const { getStatus } = require('../controllers/authController');

const router = express.Router();

router.get('/status', getStatus);
router.post('/create-event', createCalendarEvent);
router.post('/create', createCalendarEvent);

module.exports = router;

