const { getDb } = require('../utils/firestoreAdmin');
const { verifyUidFromToken } = require('./aiAccess');

function parseAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAdmin(req, res, next) {
  try {
    // Admin identity comes ONLY from a verified Firebase ID token. The
    // x-user-uid header is not trusted here (it let anyone act as an admin by
    // sending the admin's uid), and AI_REQUIRE_TOKEN=false does not relax it.
    const uid = await verifyUidFromToken(req);
    if (!uid) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing or invalid auth token' });
    }

    const db = getDb();
    if (!db) {
      return res.status(500).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
    }

    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) {
      return res.status(403).json({ success: false, error: 'ADMIN_REQUIRED' });
    }

    const data = snap.data() || {};
    const isAdminFlag = data.isAdmin === true;
    const email = String(data.email || data.userEmail || data.loginEmail || '').trim().toLowerCase();
    const allowedEmails = parseAdminEmails();
    const emailAllowed = allowedEmails.length === 0 || (email && allowedEmails.includes(email));

    if (!isAdminFlag || !emailAllowed) {
      return res.status(403).json({ success: false, error: 'ADMIN_REQUIRED' });
    }

    req.adminUid = uid;
    req.adminEmail = email;
    return next();
  } catch (e) {
    console.error('[AdminAuth] failed', e.message);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
}

module.exports = {
  requireAdmin,
};
