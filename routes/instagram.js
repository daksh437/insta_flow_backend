const express = require('express');
const {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
} = require('../controllers/instagramController');
const { softRequireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// TEMPORARY: softRequireAuth (not requireAuth) — the currently-live app build
// never sent an Authorization token on these routes, only x-user-uid, so a
// hard requirement 401s every existing install until they update. Switch
// back to requireAuth once the fixed build has rolled out. See
// middleware/verifyAuth.js for details.
//
// Applied per-route (NOT router.use(softRequireAuth)) — this router is
// mounted at app root ('/') because these routes don't share a common path
// prefix. A blanket router.use() here would run for every request that
// enters this router regardless of which path it matches, and since it's
// mounted at '/' that means EVERY request to the whole backend (including
// unrelated routers registered after this one in app.js, like /health,
// /version, /retention/health) — a real incident this caused: those
// endpoints started 401ing because they have no uid to offer. Per-route
// middleware avoids that entirely.
router.post('/instagram-connect', softRequireAuth, connectInstagram);
router.get('/instagram-stats', softRequireAuth, getInstagramStats);
router.post('/instagram/media', softRequireAuth, strictLimiter, createMedia);
router.post('/instagram/media/publish', softRequireAuth, strictLimiter, publishMedia);
router.get('/instagram/insights', softRequireAuth, getInsights);

module.exports = router;
