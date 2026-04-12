/**
 * Google OAuth tokens in Firestore `google_tokens/{userId}` (persistent across restarts).
 */
const { getDb, getAdmin } = require('./firestoreAdmin');

const COLLECTION = 'google_tokens';

const TOKEN_KEYS = ['access_token', 'refresh_token', 'expiry_date', 'token_type', 'scope', 'id_token'];

function buildCredentialObject(data) {
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const k of TOKEN_KEYS) {
    if (data[k] !== undefined && data[k] !== null) out[k] = data[k];
  }
  return Object.keys(out).length ? out : null;
}

async function getTokens(userId) {
  if (!userId) return null;
  const db = getDb();
  if (!db) {
    console.warn('[tokenStore] getTokens: Firestore not initialized');
    return null;
  }
  try {
    const snap = await db.collection(COLLECTION).doc(String(userId)).get();
    if (!snap.exists) return null;
    return buildCredentialObject(snap.data());
  } catch (e) {
    console.error('[tokenStore] getTokens error:', e.message);
    return null;
  }
}

async function saveTokens(userId, tokens) {
  if (!userId) throw new Error('saveTokens: missing userId');
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable — cannot save OAuth tokens');

  const admin = getAdmin();
  const FieldValue = admin.firestore.FieldValue;

  const patch = {};
  for (const k of TOKEN_KEYS) {
    if (tokens[k] !== undefined) patch[k] = tokens[k];
  }

  await db
    .collection(COLLECTION)
    .doc(String(userId))
    .set(
      {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function hasTokens(userId) {
  const t = await getTokens(userId);
  return !!(t && t.refresh_token);
}

module.exports = {
  getTokens,
  saveTokens,
  hasTokens,
};
