const axios = require('axios');
const { getDb } = require('../utils/firestoreAdmin');
const instagramService = require('../services/instagram_service');

function sanitize(value) {
  return String(value || '').trim();
}

function requiredConfig() {
  const appId = sanitize(process.env.INSTAGRAM_APP_ID);
  const appSecret = sanitize(process.env.INSTAGRAM_APP_SECRET);
  const redirectUri = sanitize(process.env.INSTAGRAM_REDIRECT_URI);
  if (!appId || !appSecret || !redirectUri) {
    const err = new Error('Instagram auth env is not configured');
    err.status = 500;
    err.code = 'instagram_config_missing';
    throw err;
  }
  return { appId, appSecret, redirectUri };
}

function callbackHtml(ok, message) {
  const title = ok ? 'Instagram Connected' : 'Instagram Connection Failed';
  const symbol = ok ? '✅' : '❌';
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; background:#101426; color:#fff; display:flex; min-height:100vh; align-items:center; justify-content:center; }
      .card { max-width:560px; margin:24px; padding:28px; border-radius:14px; background:#1a2140; border:1px solid #2b3768; text-align:center; }
      .symbol { font-size:44px; margin-bottom:8px; }
      h1 { margin: 0 0 8px 0; font-size: 22px; }
      p { margin: 0; line-height:1.5; color:#d6dcff; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="symbol">${symbol}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <p style="margin-top:10px;">You can close this tab and return to the app.</p>
    </div>
  </body>
</html>`;
}

function getUid(req) {
  return sanitize(req.query.state || req.query.userId || req.headers['x-user-uid']);
}

async function exchangeCodeForShortToken({ code, appId, appSecret, redirectUri }) {
  const url = 'https://api.instagram.com/oauth/access_token';
  const payload = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const response = await axios.post(url, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
    const message =
      response.data?.error_message ||
      response.data?.error?.message ||
      'Failed to exchange authorization code';
    const err = new Error(message);
    err.status = 400;
    err.code = 'instagram_code_exchange_failed';
    throw err;
  }
  return response.data;
}

async function exchangeShortForLongToken({ shortToken, appSecret }) {
  const response = await axios.get('https://graph.instagram.com/access_token', {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: appSecret,
      access_token: shortToken,
    },
    timeout: 25000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300 || !response.data?.access_token) {
    const message =
      response.data?.error?.message ||
      response.data?.error_message ||
      'Failed to exchange long-lived token';
    const err = new Error(message);
    err.status = 400;
    err.code = 'instagram_long_token_exchange_failed';
    throw err;
  }
  return response.data;
}

async function saveInstagramAuth({ uid, instagramUserId, accessToken, expiresIn }) {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 500;
    err.code = 'firestore_unavailable';
    throw err;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(expiresIn || 0) * 1000);
  const profile = await instagramService.getUserProfile(accessToken);

  await db.collection('users').doc(uid).set(
    {
      instagram: {
        userId: uid,
        connected: true,
        instagram_user_id: sanitize(instagramUserId || profile.id),
        username: sanitize(profile.username),
        account_type: sanitize(profile.account_type),
        followers_count: Number(profile.followers_count || 0),
        media_count: Number(profile.media_count || 0),
        access_token: accessToken,
        expires_in: Number(expiresIn || 0),
        token_expires_in: Number(expiresIn || 0),
        token_created_at: now,
        token_expires_at: expiresAt,
        connected_at: now,
        updated_at: now,
      },
    },
    { merge: true }
  );

  await db
    .collection('users')
    .doc(uid)
    .collection('instagram_data')
    .doc('profile')
    .set(
      {
        userId: uid,
        instagram_user_id: sanitize(instagramUserId || profile.id),
        username: sanitize(profile.username),
        followers_count: Number(profile.followers_count || 0),
        media_count: Number(profile.media_count || 0),
        access_token: accessToken,
        expires_in: Number(expiresIn || 0),
        expires_at: expiresAt,
        updated_at: now,
      },
      { merge: true }
    );
}

async function instagramCallback(req, res) {
  const uid = getUid(req);
  const code = sanitize(req.query.code);
  if (!uid) {
    return res.status(400).send(callbackHtml(false, 'Missing state/user id from OAuth callback.'));
  }
  if (!code) {
    return res.status(400).send(callbackHtml(false, 'Missing authorization code.'));
  }
  try {
    const { appId, appSecret, redirectUri } = requiredConfig();
    const shortTokenData = await exchangeCodeForShortToken({
      code,
      appId,
      appSecret,
      redirectUri,
    });

    const shortToken = sanitize(shortTokenData.access_token);
    const longTokenData = await exchangeShortForLongToken({
      shortToken,
      appSecret,
    });

    await saveInstagramAuth({
      uid,
      instagramUserId: shortTokenData.user_id,
      accessToken: sanitize(longTokenData.access_token),
      expiresIn: Number(longTokenData.expires_in || 0),
    });

    return res.status(200).send(callbackHtml(true, 'Instagram Business account connected successfully.'));
  } catch (error) {
    const status = Number(error?.status || 500);
    return res.status(status).send(callbackHtml(false, sanitize(error?.message || 'Connection failed.')));
  }
}

async function instagramStatus(req, res) {
  const uid = getUid(req);
  if (!uid) {
    return res.status(400).json({ success: false, code: 'missing_user', error: 'Missing user id' });
  }
  try {
    const db = getDb();
    if (!db) {
      return res.status(500).json({ success: false, code: 'firestore_unavailable', error: 'Firestore unavailable' });
    }
    const userSnap = await db.collection('users').doc(uid).get();
    const instagram = userSnap.data()?.instagram || {};
    const connected = instagram.connected === true && sanitize(instagram.access_token).length > 0;
    const now = Date.now();
    const expiresAtMs =
      instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
        ? instagram.token_expires_at.toDate().getTime()
        : null;
    const tokenExpired = expiresAtMs != null ? expiresAtMs <= now : false;

    return res.json({
      success: true,
      connected,
      tokenExpired,
      username: sanitize(instagram.username),
      instagram_user_id: sanitize(instagram.instagram_user_id),
    });
  } catch (error) {
    return res.status(500).json({ success: false, code: 'status_check_failed', error: sanitize(error.message) });
  }
}

module.exports = {
  instagramCallback,
  instagramStatus,
};
