/**
 * Meta (Instagram) app callbacks that must keep working while the Meta app is
 * still registered, even though InstaFlow no longer offers Instagram login:
 *   POST /auth/instagram/deauthorize
 *   POST /auth/instagram/data-deletion   (Data Deletion Request URL)
 *   GET  /auth/instagram/deletion-status
 * They only ever DELETE stored Instagram data. Remove this file (and the
 * INSTAGRAM_APP_SECRET env var) once the Meta app itself is deleted.
 */
const crypto = require('crypto');
const { getDb, getAdmin } = require('../utils/firestoreAdmin');

const sanitize = (v) => String(v || '').trim();

function base64UrlDecode(str) {
  const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

/** Verify + decode Meta's signed_request. */
function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, payload] = String(signedRequest || '').split('.');
  if (!encodedSig || !payload || !appSecret) return null;
  try {
    const sig = base64UrlDecode(encodedSig);
    const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    return JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch (_) {
    return null;
  }
}

/** Remove a user's stored Instagram data (token + cached profile) by IG user id. */
async function deleteInstagramDataByIgUserId(igUserId) {
  const db = getDb();
  if (!db || !igUserId) return;
  const snap = await db.collection('users').where('instagram.instagram_user_id', '==', String(igUserId)).get();
  const del = getAdmin().firestore.FieldValue.delete();
  await Promise.all(snap.docs.map(async (doc) => {
    await doc.ref.update({ instagram: del });
    await doc.ref.collection('instagram_data').doc('profile').delete().catch(() => {});
  }));
}

async function instagramDeauthorize(req, res) {
  const data = parseSignedRequest(req.body?.signed_request, sanitize(process.env.INSTAGRAM_APP_SECRET));
  try {
    if (data && data.user_id) await deleteInstagramDataByIgUserId(String(data.user_id));
  } catch (e) {
    console.error('[meta] deauthorize error:', e.message);
  }
  return res.status(200).json({ success: true });
}

async function instagramDataDeletion(req, res) {
  const data = parseSignedRequest(req.body?.signed_request, sanitize(process.env.INSTAGRAM_APP_SECRET));
  const code = data && data.user_id ? String(data.user_id) : `unverified-${Date.now()}`;
  try {
    if (data && data.user_id) await deleteInstagramDataByIgUserId(String(data.user_id));
  } catch (e) {
    console.error('[meta] data deletion error:', e.message);
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  return res.status(200).json({
    url: `${origin}/auth/instagram/deletion-status?id=${encodeURIComponent(code)}`,
    confirmation_code: code,
  });
}

function instagramDeletionStatus(req, res) {
  const id = sanitize(req.query.id).replace(/[^\w-]/g, '');
  res.status(200).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>InstaFlow</title>` +
    `<p>Your InstaFlow Instagram data has been deleted. Confirmation code: ${id || 'n/a'}</p>`
  );
}

module.exports = { instagramDeauthorize, instagramDataDeletion, instagramDeletionStatus };
