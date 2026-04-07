const express = require('express');
const { synthesizeTts } = require('../controllers/ttsController');

const router = express.Router();

router.post('/tts', synthesizeTts);

module.exports = router;
