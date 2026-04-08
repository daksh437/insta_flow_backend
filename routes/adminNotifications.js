const express = require('express');
const { requireAdmin } = require('../middleware/adminAuth');
const { previewCampaign, sendCampaign } = require('../controllers/adminNotificationsController');

const router = express.Router();

router.post('/notifications/preview', requireAdmin, previewCampaign);
router.post('/notifications/send', requireAdmin, sendCampaign);

module.exports = router;
