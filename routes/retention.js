const express = require('express');
const {
  missionToday,
  missionView,
  missionCompleteTask,
  recommendations,
  weeklyReport,
} = require('../controllers/retentionController');

const router = express.Router();

/** No auth — use to verify deployed build exposes retention routes (Render / health checks). */
router.get('/health', (_req, res) => {
  res.json({
    success: true,
    service: 'retention',
    routes: [
      'GET /retention/health',
      'GET /retention/mission/today',
      'POST /retention/mission/view',
      'POST /retention/mission/complete-task',
      'GET /retention/recommendations',
      'GET /retention/weekly-report',
    ],
  });
});

router.get('/mission/today', missionToday);
router.post('/mission/view', missionView);
router.post('/mission/complete-task', missionCompleteTask);
router.get('/recommendations', recommendations);
router.get('/weekly-report', weeklyReport);

module.exports = router;
