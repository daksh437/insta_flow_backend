const { getAdmin, getDb } = require('../utils/firestoreAdmin');

// Collects every valid FCM token stored on a user doc (supports both the
// `fcmTokens` array and a legacy single `fcmToken` string).
function tokensFromUser(userData) {
  const arr = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  const one = typeof userData.fcmToken === 'string' ? [userData.fcmToken] : [];
  const out = [...arr, ...one].map((t) => String(t || '').trim()).filter(Boolean);
  return Array.from(new Set(out));
}

/**
 * Push to one user's devices. Dead tokens are removed from their doc.
 * Only for account messages (trial reminder). Marketing pushes go through
 * services/marketingPush.js, which applies the opt-outs, cap and quiet hours.
 * @returns {Promise<{targetTokens:number, successCount:number}>}
 */
async function sendPushToUser(uid, { title, body, data = {} } = {}) {
  const admin = getAdmin();
  const db = getDb();
  if (!admin || !db || !uid || !title || !body) return { targetTokens: 0, successCount: 0 };
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const tokens = snap.exists ? tokensFromUser(snap.data() || {}) : [];
  if (tokens.length === 0) return { targetTokens: 0, successCount: 0 };
  const sender = admin.messaging().sendEachForMulticast
    ? admin.messaging().sendEachForMulticast.bind(admin.messaging())
    : admin.messaging().sendMulticast.bind(admin.messaging());
  const resp = await sender({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
    android: { priority: 'high', notification: { channelId: 'general' } },
  });
  const dead = [];
  (resp.responses || []).forEach((r, i) => {
    const code = (r.error && r.error.code) || '';
    if (!r.success && (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token'))) {
      dead.push(tokens[i]);
    }
  });
  if (dead.length) {
    const existing = Array.isArray(snap.data().fcmTokens) ? snap.data().fcmTokens : [];
    await ref.update({ fcmTokens: existing.filter((t) => !dead.includes(String(t))) }).catch(() => null);
  }
  return { targetTokens: tokens.length, successCount: Number(resp.successCount || 0) };
}

module.exports = { sendPushToUser };
