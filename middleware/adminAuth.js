const { getDb } = require('../utils/firestoreAdmin');

function parseAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAdmin(req, res, next) {
  try {
    const uid = String(req.headers['x-user-uid'] || req.headers['X-User-UID'] || '').trim();
    if (!uid) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing x-user-uid' });
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
