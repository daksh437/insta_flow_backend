const axios = require('axios');
const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const instagramService = require('../services/instagram_service');
const { verifyOAuthState } = require('../utils/oauthState');

function sanitize(value) {
  return String(value || '').trim();
}

function base64UrlDecode(str) {
  const padded = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  return Buffer.from(withPad, 'base64');
}

/** Verify + decode Meta's `signed_request` (deauthorize / data-deletion callbacks). */
function parseSignedRequest(signedRequest, appSecret) {
  const parts = String(signedRequest || '').split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, payload] = parts;
  if (!encodedSig || !payload) return null;
  try {
    const sig = base64UrlDecode(encodedSig);
    const expectedSig = crypto.createHmac('sha256', appSecret).update(payload).digest();
    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) return null;
    return JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** Clear a user's stored Instagram connection (token + cached profile) by IG user id. */
async function clearInstagramConnectionByIgUserId(igUserId) {
  const db = getDb();
  if (!db || !igUserId) return;
  const snap = await db.collection('users').where('instagram.instagram_user_id', '==', String(igUserId)).get();
  const now = new Date();
  await Promise.all(
    snap.docs.map(async (doc) => {
      await doc.ref.set(
        {
          instagram: {
            connected: false,
            access_token: null,
            instagram_user_id: null,
            username: null,
            account_type: null,
            followers_count: 0,
            media_count: 0,
            deauthorized_at: now,
            updated_at: now,
          },
        },
        { merge: true }
      );
      await doc.ref.collection('instagram_data').doc('profile').delete().catch(() => {});
    })
  );
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
  const verified = verifyOAuthState(req.query.state, 'instagram');
  if (verified.ok) return sanitize(verified.uid);
  // Backward compatibility for old clients still sending plain UID in non-production.
  const env = (process.env.NODE_ENV || 'development').toLowerCase();
  if (env !== 'production') {
    return sanitize(req.query.userId || req.headers['x-user-uid'] || req.query.state);
  }
  return '';
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
  console.log('[instagramAuth] S2 short token prefix:', String(shortToken || '').slice(0, 6), 'len:', String(shortToken || '').length);
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
    console.error('[instagramAuth] S2 long-token FAILED', {
      status: response.status,
      body: response.data,
    });
    const e = response.data?.error || {};
    const base = e.message || response.data?.error_message || 'Failed to exchange long-lived token';
    const message = `${base} (http=${response.status} code=${e.code || ''} sub=${e.error_subcode || ''} type=${e.type || ''})`;
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
  // Profile fetch is BEST-EFFORT. The important thing is the access token — if
  // Instagram rejects the /me profile request (field/permission/account-type
  // quirks), we still save the token and mark the account connected so the user
  // isn't blocked. Profile details refresh later via getInstagramStats.
  let profile = {};
  try {
    profile = await instagramService.getUserProfile(accessToken);
  } catch (e) {
    console.error('[instagramAuth] getUserProfile failed (continuing, token still saved):', e?.message || e);
  }

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
  let step = 'config';
  try {
    const { appId, appSecret, redirectUri } = requiredConfig();
    step = 'S1_exchange_code';
    console.log('[instagramAuth] Step 1: exchanging code for short-lived token...');
    const shortTokenData = await exchangeCodeForShortToken({
      code,
      appId,
      appSecret,
      redirectUri,
    });
    console.log('[instagramAuth] Step 1 OK. Step 2: exchanging for long-lived token...');

    step = 'S2_long_token';
    const shortToken = sanitize(shortTokenData.access_token);
    // Try to upgrade to a 60-day long-lived token. If Instagram rejects the
    // exchange (app-config/token-type quirks), fall back to the short-lived
    // token so the connection STILL succeeds — the user isn't blocked, and the
    // token can be refreshed later.
    let accessToken = shortToken;
    let expiresIn = Number(shortTokenData.expires_in || 3600);
    try {
      const longTokenData = await exchangeShortForLongToken({ shortToken, appSecret });
      accessToken = sanitize(longTokenData.access_token) || shortToken;
      expiresIn = Number(longTokenData.expires_in || expiresIn);
      console.log('[instagramAuth] Step 2 OK (long-lived token).');
    } catch (e) {
      console.warn('[instagramAuth] Step 2 long-token exchange failed — using short-lived token:', e?.message);
    }
    console.log('[instagramAuth] Step 3: saving auth + fetching profile...');

    step = 'S3_save';
    await saveInstagramAuth({
      uid,
      instagramUserId: shortTokenData.user_id,
      accessToken,
      expiresIn,
    });
    console.log('[instagramAuth] Step 3 OK. Connected uid=', uid);

    return res.status(200).send(callbackHtml(true, 'Instagram Business account connected successfully.'));
  } catch (error) {
    console.error('[instagramAuth] Callback failed:', {
      step,
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });
    const status = Number(error?.status || 500);
    return res.status(status).send(callbackHtml(false, `[${step}] ${sanitize(error?.message || 'Connection failed.')}`));
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

/**
 * POST /auth/instagram/deauthorize — Meta calls this when a user removes the
 * app from their Instagram "Apps and websites" list. Required config field:
 * App Dashboard -> Instagram -> API setup with Instagram login -> Deauthorize
 * Callback URL. Must always return 200; Meta does not retry on non-200 but
 * treats it as a setup problem.
 */
async function instagramDeauthorize(req, res) {
  try {
    const appSecret = sanitize(process.env.INSTAGRAM_APP_SECRET);
    const data = parseSignedRequest(req.body?.signed_request, appSecret);
    if (data && data.user_id) {
      await clearInstagramConnectionByIgUserId(String(data.user_id));
      console.log('[instagramAuth] Deauthorized ig user_id=', data.user_id);
    } else {
      console.warn('[instagramAuth] Deauthorize: invalid or unverifiable signed_request');
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[instagramAuth] Deauthorize error:', error?.message || error);
    return res.status(200).json({ success: true });
  }
}

/**
 * POST /auth/instagram/data-deletion — Meta calls this when a user requests
 * their data be deleted. Required config field: App Dashboard -> Instagram ->
 * API setup with Instagram login -> Data Deletion Request URL. Must respond
 * 200 with { url, confirmation_code } per Meta's spec.
 */
async function instagramDataDeletion(req, res) {
  const appSecret = sanitize(process.env.INSTAGRAM_APP_SECRET);
  const data = parseSignedRequest(req.body?.signed_request, appSecret);
  const confirmationCode = data && data.user_id ? String(data.user_id) : `unverified-${Date.now()}`;
  try {
    if (data && data.user_id) {
      await clearInstagramConnectionByIgUserId(String(data.user_id));
      console.log('[instagramAuth] Data deletion processed for ig user_id=', data.user_id);
    } else {
      console.warn('[instagramAuth] Data deletion: invalid or unverifiable signed_request');
    }
  } catch (error) {
    console.error('[instagramAuth] Data deletion error:', error?.message || error);
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  return res.status(200).json({
    url: `${origin}/auth/instagram/deletion-status?id=${encodeURIComponent(confirmationCode)}`,
    confirmation_code: confirmationCode,
  });
}

/** GET /auth/instagram/deletion-status?id=... — human-readable confirmation page linked from the JSON response above. */
async function instagramDeletionStatus(req, res) {
  const id = sanitize(req.query.id);
  return res.status(200).send(callbackHtml(true, `Your InstaFlow Instagram data has been deleted. Confirmation code: ${id || 'n/a'}`));
}

module.exports = {
  instagramCallback,
  instagramStatus,
  instagramDeauthorize,
  instagramDataDeletion,
  instagramDeletionStatus,
};
