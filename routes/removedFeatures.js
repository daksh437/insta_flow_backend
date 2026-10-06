/**
 * Instagram login/publishing/scheduling and Google Calendar were removed
 * (October 2026). Their old endpoints answer 410 Gone with a clear message,
 * so older app builds (e.g. build 48) show it instead of a generic error.
 * Meta's deauthorize/data-deletion callbacks are NOT here: routes/auth.js
 * keeps them until the Meta app is deactivated.
 */
const express = require('express');

const router = express.Router();

const INSTAGRAM = {
  error: 'FEATURE_REMOVED',
  message: 'Instagram scheduling has been removed from InstaFlow.',
};
const CALENDAR = {
  error: 'FEATURE_REMOVED',
  message: 'Google Calendar integration has been removed from InstaFlow.',
};

const gone = (body) => (_req, res) => res.status(410).json({ success: false, ...body });

router.all(
  [
    '/instagram-connect',
    '/instagram-stats',
    '/instagram/*',
    '/scheduler',
    '/scheduler/*',
    '/auth/instagram/callback',
    '/auth/instagram/status',
  ],
  gone(INSTAGRAM)
);

router.all(
  ['/calendar', '/calendar/*', '/auth/google', '/auth/google/callback', '/auth/url', '/auth/status'],
  gone(CALENDAR)
);

module.exports = router;
