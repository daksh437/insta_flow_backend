/**
 * Shared auth guard for non-AI routes (instagram, calendar, auth-status, referrals).
 * Reuses the same verified-Firebase-ID-token check already proven on the /ai/*
 * path (middleware/aiAccess.js) instead of trusting a client-supplied
 * x-user-uid header, which let any caller act as an arbitrary user (e.g.
 * publish to someone else's Instagram, redeem referral codes on their behalf).
 */

const { verifyUidFromToken, REQUIRE_AUTH_TOKEN } = require('./aiAccess');

/** Express middleware: requires a verified Firebase ID token, sets req.uid. */
async function requireAuth(req, res, next) {
  const verifiedUid = await verifyUidFromToken(req);
  let uid = verifiedUid;
  if (!uid && !REQUIRE_AUTH_TOKEN) {
    // Safety valve only: header-trust when token enforcement is explicitly off
    // via AI_REQUIRE_TOKEN=false, same rollback switch used on the AI path.
    uid = String(
      req.headers['x-user-uid'] ||
        req.headers['X-User-UID'] ||
        req.headers['x-user-id'] ||
        req.body?.userId ||
        req.query?.userId ||
        ''
    ).trim() || null;
  }
  if (!uid) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid auth token',
    });
  }
  req.uid = uid;
  next();
}

/**
 * TEMPORARY compatibility shim for /instagram/* — remove once the app build
 * that sends Authorization on Instagram calls (added 2026-08-05) has rolled
 * out to the active install base, then swap routes/instagram.js back to
 * requireAuth. Until then: a verified token (updated clients) is preferred
 * and always wins; a bare x-user-uid header (currently-live clients, which
 * never sent a token for these routes) is accepted as a fallback so
 * Instagram connect/stats/publish don't stay broken for existing users.
 * This reopens the original uid-spoofing hole for callers with no token.
 */
async function softRequireAuth(req, res, next) {
  const verifiedUid = await verifyUidFromToken(req);
  const uid = verifiedUid || String(
    req.headers['x-user-uid'] ||
      req.headers['X-User-UID'] ||
      req.headers['x-user-id'] ||
      req.body?.userId ||
      req.query?.userId ||
      ''
  ).trim();
  if (!uid) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid auth token',
    });
  }
  req.uid = uid;
  next();
}

module.exports = { requireAuth, softRequireAuth };
