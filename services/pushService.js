const { getAdmin, getDb } = require('../utils/firestoreAdmin');

// Collects every valid FCM token stored on a user doc (supports both the
// `fcmTokens` array and a legacy single `fcmToken` string).
function tokensFromUser(userData) {
  const arr = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  const one = typeof userData.fcmToken === 'string' ? [userData.fcmToken] : [];
  const out = [...arr, ...one].map((t) => String(t || '').trim()).filter(Boolean);
  return Array.from(new Set(out));
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Send a push notification to every user that has at least one FCM token.
 * `filter(userData)` is optional — return false to skip a user.
 * Invalid/expired tokens are best-effort cleaned from Firestore so the token
 * list doesn't rot over time.
 *
 * @returns {Promise<{targetTokens:number, successCount:number, failureCount:number}>}
 */
async function sendPushToAllUsers({ title, body, data = {}, filter = null } = {}) {
  const admin = getAdmin();
  const db = getDb();
  if (!admin || !db) {
    console.warn('[push] Firebase Admin/DB unavailable — skipping push');
    return { targetTokens: 0, successCount: 0, failureCount: 0 };
  }
  if (!title || !body) {
    console.warn('[push] Missing title/body — skipping push');
    return { targetTokens: 0, successCount: 0, failureCount: 0 };
  }

  const snap = await db.collection('users').limit(5000).get();
  const allTokens = new Set();
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (typeof filter === 'function' && !filter(d)) continue;
    tokensFromUser(d).forEach((t) => allTokens.add(t));
  }

  const tokens = Array.from(allTokens);
  if (tokens.length === 0) {
    console.log('[push] No FCM tokens found — nobody to notify');
    return { targetTokens: 0, successCount: 0, failureCount: 0 };
  }

  const sender = admin.messaging().sendEachForMulticast
    ? admin.messaging().sendEachForMulticast.bind(admin.messaging())
    : admin.messaging().sendMulticast.bind(admin.messaging());

  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = new Set();
  const stringData = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, String(v)])
  );

  for (const batch of chunk(tokens, 500)) {
    const resp = await sender({
      tokens: batch,
      notification: { title, body },
      data: stringData,
      android: { priority: 'high', notification: { channelId: 'general' } },
    });
    successCount += Number(resp.successCount || 0);
    failureCount += Number(resp.failureCount || 0);
    (resp.responses || []).forEach((r, idx) => {
      if (r.success) return;
      const code = r.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        invalidTokens.add(batch[idx]);
      }
    });
  }

  // Best-effort cleanup of dead tokens.
  if (invalidTokens.size > 0) {
    const invalid = Array.from(invalidTokens);
    for (const slice of chunk(invalid, 10)) {
      const usersSnap = await db
        .collection('users')
        .where('fcmTokens', 'array-contains-any', slice)
        .get()
        .catch(() => null);
      if (!usersSnap || usersSnap.empty) continue;
      const batch = db.batch();
      usersSnap.docs.forEach((doc) => {
        const existing = Array.isArray(doc.data().fcmTokens) ? doc.data().fcmTokens : [];
        batch.update(doc.ref, { fcmTokens: existing.filter((t) => !invalid.includes(String(t))) });
      });
      await batch.commit().catch(() => null);
    }
  }

  console.log(`[push] Sent "${title}" → tokens=${tokens.length} ok=${successCount} fail=${failureCount}`);
  return { targetTokens: tokens.length, successCount, failureCount };
}

module.exports = { sendPushToAllUsers };
