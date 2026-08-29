console.log("🔥 MAIN APP.JS RUNNING");
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { globalLimiter } = require('./middleware/rateLimiters');

const authRoutes = require('./routes/auth');
const geminiRoutes = require('./routes/gemini');
const aiAccessRoutes = require('./routes/aiAccess');
const calendarRoutes = require('./routes/calendar');
const dailyDropRoutes = require('./routes/dailyDrop');
const ttsRoutes = require('./routes/tts');
const adminNotificationsRoutes = require('./routes/adminNotifications');
const retentionRoutes = require('./routes/retention');
const instagramRoutes = require('./routes/instagram');
const schedulerRoutes = require('./routes/scheduler');
const rewardsRoutes = require('./routes/rewards');
const accountRoutes = require('./routes/account');
const { generateDailyDrop } = require('./services/dailyDropGenerator');
const { processPendingScheduledPosts } = require('./services/scheduler_service');
const { sendPushToAllUsers } = require('./services/pushService');
const { buildAiFallback } = require('./utils/aiFallback');
const { apiError } = require('./utils/response');
const { parseCorsOrigins, buildCorsOptions } = require('./utils/corsConfig');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Render sits behind a reverse proxy — without this, express-rate-limit sees
// every request as coming from the same proxy IP and can't rate-limit per
// real client (req.ip needs X-Forwarded-For).
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// No per-user auth has run yet at this point, so this is IP-based defense
// against brute force / scripted abuse — a floor under the per-user credit
// system, not a replacement for it.
app.use(globalLimiter);

const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);
if (IS_PROD && corsOrigins.length === 0) {
  // Mobile app requests carry no Origin header, so buildCorsOptions always
  // allows them. Warn (don't crash) when CORS_ORIGINS is unset — set it only if
  // a browser/web client is added.
  console.warn('[cors] CORS_ORIGINS not set in production — allowing no-origin (mobile) requests only.');
}
app.use(cors(buildCorsOptions(corsOrigins, IS_PROD)));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use((req, res, next) => {
  if (!IS_PROD) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

app.get('/', (req, res) => {
  res.json({ success: true, message: 'InstaFlow Backend API' });
});

app.use('/auth', authRoutes);

app.use('/', aiAccessRoutes);
app.use('/ai', geminiRoutes);
app.use('/', instagramRoutes);
app.use('/calendar', calendarRoutes);
app.use('/daily-drop', dailyDropRoutes);
app.use('/api', ttsRoutes);
app.use('/admin', adminNotificationsRoutes);
app.use('/retention', retentionRoutes);
app.use('/scheduler', schedulerRoutes);
app.use('/rewards', rewardsRoutes);
app.use('/account', accountRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', success: true, message: 'OK' });
});

// Deploy verification marker — bump this string on each deploy to confirm
// Render actually shipped the latest commit.
app.get('/version', (_req, res) => {
  res.json({ success: true, build: '2026-08-29-account-delete-cascade' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.error('[ERROR Details]', err);
  console.error('[ERROR Stack]', err.stack);
  if (!res.headersSent && req.path.startsWith('/ai/')) {
    const fallback = buildAiFallback(req.path, req.body || {});
    const errorCode = String(err?.code || 'AI_FALLBACK');
    console.warn('[AI Global Fallback]', req.path, { code: errorCode, message: err?.message || 'unknown' });
    return res.json({
      success: true,
      data: fallback,
      fallback: true,
      meta: {
        errorCode,
      },
      ok: true,
    });
  }
  return apiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error');
});

function validateRuntimeGuards() {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const geminiMode = (apiKey && apiKey.trim() !== '') ? 'REAL MODE' : 'MOCK MODE';
  const devSkipLimits = process.env.DEV_SKIP_LIMITS === 'true' || process.env.DEV_SKIP_LIMITS === '1';

  if (IS_PROD && devSkipLimits) {
    throw new Error('DEV_SKIP_LIMITS must not be enabled in production.');
  }

  const { auditAiRoutes } = require('./scripts/auditAiRoutes');
  auditAiRoutes(app);
  return { modelName, geminiMode };
}

function startServer() {
  const { modelName, geminiMode } = validateRuntimeGuards();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server running on port', PORT);
  console.log('Server running on', PORT);
  console.log(`🚀 InstaFlow backend running on port ${PORT} (process.env.PORT)`);
  console.log(`📘 Instagram Business OAuth: GET /auth/instagram/callback`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🤖 Gemini AI: ${geminiMode}`);
  console.log(`🤖 Gemini Model: ${modelName}`);
  console.log(`✅ Server ready for requests!`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`📅 Daily drop: GET http://0.0.0.0:${PORT}/daily-drop/today`);
  console.log('[Retention] Mounted at /retention — GET /retention/health (no auth), mission, recommendations, weekly-report');

  if (IS_PROD) {
    console.log(`☁️  Production mode: Server accessible from all network interfaces`);
  } else {
    console.log(`💻 Development mode: http://localhost:${PORT}`);
  }

  cron.schedule('0 0 * * *', () => {
    generateDailyDrop().catch((err) => {
      console.error('[DailyDrop] Cron job failed:', err);
    });
  });
  console.log('⏰ Daily Viral Drop cron scheduled (00:00 daily)');

  cron.schedule('* * * * *', () => {
    processPendingScheduledPosts().catch((err) => {
      console.error('[Scheduler] Cron publish failed:', err?.message || err);
    });
  });
  console.log('⏰ Instagram scheduler cron scheduled (every minute)');

  // Daily Viral Drop push — 13:30 UTC = 7:00 PM IST (prime engagement hour for
  // our India-first audience). Pulls users back to the hero feature every day.
  cron.schedule('30 13 * * *', () => {
    sendPushToAllUsers({
      title: "🔥 Today's Viral Drop is ready",
      body: 'Your trending idea + hook + hashtags are waiting. Tap to create your next post.',
      data: { deepLink: '/daily-viral-drop', type: 'daily_drop' },
    }).catch((err) => {
      console.error('[Push] Daily drop push failed:', err?.message || err);
    });
  });
  console.log('⏰ Daily Viral Drop push cron scheduled (13:30 UTC / 7 PM IST)');
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
};
