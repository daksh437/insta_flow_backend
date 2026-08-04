const rateLimit = require('express-rate-limit');

/**
 * IP-based defense against brute force / scripted abuse, applied globally in
 * app.js before any per-user auth runs. This is a floor under the per-user
 * credit system, not a replacement for it. Generous ceiling since the mobile
 * app's NAT/carrier IPs are shared by many real users.
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
});

/**
 * Tighter limit for endpoints that grant value directly (referrals, purchase
 * activation, publishing to Instagram) — worth throttling even from a
 * legitimate, authenticated account.
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Please try again shortly.' },
});

module.exports = { globalLimiter, strictLimiter };
