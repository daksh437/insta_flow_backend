const express = require('express');
const {
  instagramDeauthorize,
  instagramDataDeletion,
  instagramDeletionStatus,
} = require('../controllers/metaDataDeletionController');

const router = express.Router();

// Instagram login, Instagram publishing/scheduling and Google Calendar were
// removed (October 2026). Only Meta's deletion callbacks remain, until the
// Meta app is deleted: they can only delete stored Instagram data.
router.post('/instagram/deauthorize', instagramDeauthorize);
router.post('/instagram/data-deletion', instagramDataDeletion);
router.get('/instagram/deletion-status', instagramDeletionStatus);

module.exports = router;
