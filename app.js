console.log("🔥 MAIN APP.JS RUNNING");
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const geminiRoutes = require('./routes/gemini');
const aiAccessRoutes = require('./routes/aiAccess');
const calendarRoutes = require('./routes/calendar');
const dailyDropRoutes = require('./routes/dailyDrop');
const whatsappBotRoutes = require('./routes/whatsappBot');
const { generateDailyDrop } = require('./services/dailyDropGenerator');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

const FACEBOOK_APP_ID = '918884500687686';
const FACEBOOK_REDIRECT_URI =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';
const FACEBOOK_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';

app.get('/webhook', (req, res) => {
  console.log('🔥 WEBHOOK HIT');

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'instaflow_verify_123') {
    console.log('✅ VERIFIED');
    return res.status(200).send(challenge);
  }

  return res.status(403).send('Failed');
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.post('/webhook', (req, res) => {
  console.log('📩 Incoming:', req.body);
  res.sendStatus(200);
});

console.log('[Webhook] GET + POST /webhook registered (single handler, no duplicates)');

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'x-user-uid', 'X-User-UID', 'X-Request-Time', 'X-Idempotency-Key', 'Cache-Control', 'Pragma', 'Expires'],
  })
);

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`[Request Body]`, JSON.stringify(req.body));
  }
  next();
});

app.get('/', (req, res) => {
  res.json({ success: true, message: 'InstaFlow Backend API' });
});

app.get('/auth/facebook', (req, res) => {
  const redirect_uri = FACEBOOK_REDIRECT_URI.replace(/\/$/, '');
  console.log('Redirect URI:', redirect_uri);
  const params = new URLSearchParams({
    client_id: FACEBOOK_APP_ID,
    redirect_uri: redirect_uri,
    response_type: 'code',
    scope: 'email',
  });
  const url = `${FACEBOOK_DIALOG}?${params.toString()}`;
  res.redirect(302, url);
});

app.get('/auth/facebook/callback', (req, res) => {
  const redirect_uri = FACEBOOK_REDIRECT_URI.replace(/\/$/, '');
  console.log('Redirect URI:', redirect_uri);
  const code = req.query.code;
  if (!code) {
    return res.type('text/plain').send('No code received');
  }
  return res.type('text/plain').send(`Facebook Login Success ${code}`);
});

app.use('/auth', authRoutes);
app.use('/', aiAccessRoutes);
app.use('/ai', geminiRoutes);
app.use('/calendar', calendarRoutes);
app.use('/daily-drop', dailyDropRoutes);
app.use('/', whatsappBotRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', success: true, message: 'OK' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.error('[ERROR Details]', err);
  console.error('[ERROR Stack]', err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message || 'Unknown error',
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port', PORT);
  const env = process.env.NODE_ENV || 'development';
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const geminiMode = (apiKey && apiKey.trim() !== '') ? 'REAL MODE' : 'MOCK MODE';
  const devSkipLimits = process.env.DEV_SKIP_LIMITS === 'true' || process.env.DEV_SKIP_LIMITS === '1';

  if (env === 'production' && devSkipLimits) {
    console.error('[FATAL] DEV_SKIP_LIMITS must not be enabled in production. Aborting.');
    server.close();
    process.exit(1);
  }

  const { auditAiRoutes } = require('./scripts/auditAiRoutes');
  try {
    auditAiRoutes(app);
  } catch (err) {
    console.error(err.message);
    server.close();
    process.exit(1);
  }

  console.log('Server running on', PORT);
  console.log(`🚀 InstaFlow backend running on port ${PORT} (process.env.PORT)`);
  console.log(`📲 WhatsApp webhook: GET/POST http://0.0.0.0:${PORT}/webhook`);
  console.log(`📘 Facebook OAuth: GET https://insta-flow-backend.onrender.com/auth/facebook`);
  console.log(`🌍 Environment: ${env}`);
  console.log(`🤖 Gemini AI: ${geminiMode}`);
  console.log(`🤖 Gemini Model: ${modelName}`);
  console.log(`✅ Server ready for requests!`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`📅 Daily drop: GET http://0.0.0.0:${PORT}/daily-drop/today`);

  if (env === 'production') {
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
});
