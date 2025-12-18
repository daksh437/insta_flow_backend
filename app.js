require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const authRoutes = require('./routes/auth');
const geminiRoutes = require('./routes/gemini');
const calendarRoutes = require('./routes/calendar');

const app = express();
const port = process.env.PORT || 3000;

// CORS for Flutter/web - Enable for all origins in production
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : '*', // Allow all origins if CORS_ORIGINS not set
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  })
);

// Disable caching for all responses - ensure fresh AI responses every time
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Body parsing - increased limit for image uploads
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware (before routes)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log(`[Request Body]`, JSON.stringify(req.body));
  }
  next();
});

// Routes
app.use('/auth', authRoutes);
app.use('/ai', geminiRoutes);
app.use('/calendar', calendarRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', success: true, message: 'OK' });
});

app.get('/', (_req, res) => {
  res.json({ success: true, message: 'InstaFlow Backend API' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()} ${req.method} ${req.path}`);
  console.error('[ERROR Details]', err);
  console.error('[ERROR Stack]', err.stack);
  res.status(500).json({ 
    success: false, 
    error: 'Internal Server Error',
    message: err.message || 'Unknown error'
  });
});

// Listen on all network interfaces (0.0.0.0) for cloud deployment
app.listen(port, '0.0.0.0', () => {
  const env = process.env.NODE_ENV || 'development';
  console.log(`🚀 InstaFlow backend running on port ${port}`);
  console.log(`🌍 Environment: ${env}`);
  console.log(`✅ Server ready for requests!`);
  console.log(`📊 Health check: http://0.0.0.0:${port}/health`);
  
  if (env === 'production') {
    console.log(`☁️  Production mode: Server accessible from all network interfaces`);
  } else {
    console.log(`💻 Development mode: http://localhost:${port}`);
  }
});

