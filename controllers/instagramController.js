const { getDb } = require('../utils/firestoreAdmin');
const instagramService = require('../services/instagram_service');

function getUid(req) {
  return String(
    req.headers['x-user-uid'] ||
      req.headers['X-User-UID'] ||
      req.headers['x-user-id'] ||
      req.query.userId ||
      req.body?.userId ||
      ''
  ).trim();
}

async function getStoredInstagramAuth(uid) {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 500;
    err.code = 'firestore_unavailable';
    throw err;
  }
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data() || {};
  const instagram = user.instagram || {};
  const token = String(instagram.access_token || '').trim();
  if (!token) {
    const err = new Error('Instagram not connected');
    err.status = 401;
    err.code = 'instagram_not_connected';
    throw err;
  }
  const expiresAt =
    instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
      ? instagram.token_expires_at.toDate()
      : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    const err = new Error('Instagram token expired. Please reconnect.');
    err.status = 401;
    err.code = 'token_expired';
    throw err;
  }
  return { db, token, instagram };
}

function sendError(res, error) {
  const status = Number(error?.status || 500);
  const code = String(error?.code || 'internal_error');
  const message = String(error?.message || 'Something went wrong');
  return res.status(status).json({ success: false, code, error: message });
}

async function getInstagramStats(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { db, token } = await getStoredInstagramAuth(uid);
    const profile = await instagramService.getUserProfile(token);

    await db.collection('users').doc(uid).set(
      {
        instagram: {
          connected: true,
          instagram_user_id: String(profile.id || ''),
          username: String(profile.username || ''),
          followers_count: Number(profile.followers_count || 0),
          media_count: Number(profile.media_count || 0),
          account_type: String(profile.account_type || ''),
          last_sync: new Date(),
        },
      },
      { merge: true }
    );

    return res.json({
      success: true,
      followers: Number(profile.followers_count || 0),
      following: Number(profile.follows_count || 0),
      posts: Number(profile.media_count || 0),
      username: String(profile.username || ''),
      accountType: String(profile.account_type || ''),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createMedia(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const videoUrl = String(req.body?.videoUrl || '').trim();
    const caption = String(req.body?.caption || '');
    const isReel = req.body?.isReel === true;

    const creationId = await instagramService.createMedia({
      accessToken: token,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      caption,
      isReel,
    });

    return res.json({
      success: true,
      creationId,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function publishMedia(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const creationId = String(req.body?.creationId || '').trim();
    const published = await instagramService.publishMedia({
      accessToken: token,
      creationId,
    });
    return res.json({ success: true, mediaId: published.id });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getInsights(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const data = await instagramService.getInsights(token);
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function connectInstagram(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  const redirectUri = String(process.env.INSTAGRAM_REDIRECT_URI || '').trim();
  const clientId = String(process.env.INSTAGRAM_APP_ID || '').trim();
  if (!redirectUri || !clientId) {
    return res.status(500).json({
      success: false,
      code: 'instagram_config_missing',
      error: 'INSTAGRAM_APP_ID or INSTAGRAM_REDIRECT_URI not configured',
    });
  }
  const authUrl =
    `https://www.instagram.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments' +
    '&response_type=code' +
    `&state=${encodeURIComponent(uid)}`;

  return res.json({ success: true, authUrl });
}

module.exports = {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
};
