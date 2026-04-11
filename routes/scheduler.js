const express = require('express');
const {
  createSlot,
  getSlots,
  updateSlot,
  deleteSlot,
  schedulePost,
  scheduleQueuePost,
  retryFailedPost,
  getScheduledPosts,
  updateScheduledPost,
  deleteScheduledPost,
} = require('../controllers/schedulerController');

const router = express.Router();

router.post('/slots', createSlot);
router.get('/slots', getSlots);
router.put('/slots/:slotId', updateSlot);
router.delete('/slots/:slotId', deleteSlot);
router.post('/schedule-post', schedulePost);
router.post('/schedule-queue', scheduleQueuePost);
router.post('/retry-failed/:postId', retryFailedPost);
router.get('/scheduled-posts', getScheduledPosts);
router.put('/update-post/:postId', updateScheduledPost);
router.delete('/delete-post/:postId', deleteScheduledPost);

module.exports = router;
