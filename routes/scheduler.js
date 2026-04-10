const express = require('express');
const { schedulePost, getScheduledPosts } = require('../controllers/schedulerController');

const router = express.Router();

router.post('/schedule-post', schedulePost);
router.get('/scheduled-posts', getScheduledPosts);

module.exports = router;
