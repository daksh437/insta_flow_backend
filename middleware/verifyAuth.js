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

module.exports = { requireAuth };
