/**
 * Minimal Express server showing how to mount auth + Instagram routes.
 * Production app uses app.js — copy the pattern below.
 */

require('dotenv').config();
const express = require('express');
const authRoutes = require('./routes/auth');
const instagramRoutes = require('./routes/instagram');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({ ok: true, message: 'Example server' });
});

app.use('/auth', authRoutes);
app.use('/', instagramRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Example server listening on ${PORT}`);
  console.log(`Open: http://localhost:${PORT}/auth/instagram/status?state=<uid>`);
});
