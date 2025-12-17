const express = require('express');
const { createCalendarEvent } = require('../controllers/calendarController');

const router = express.Router();

router.post('/create', createCalendarEvent);

module.exports = router;

