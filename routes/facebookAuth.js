const express = require('express');
const axios = require('axios');

const router = express.Router();

const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';
const FB_GRAPH = 'https://graph.facebook.com/v19.0';

const REDIRECT_URI =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';

/** Current Meta app — override with env FB_APP_ID in production. */
const DEFAULT_FB_APP_ID = '2116455735836499';

function getAppId() {
  return (process.env.FB_APP_ID || DEFAULT_FB_APP_ID).trim();
}

function getAppSecret() {
  return (process.env.FB_APP_SECRET || '').trim();
}

function pictureUrlFromGraph(pictureField) {
  if (pictureField == null) return null;
  if (typeof pictureField === 'string') return pictureField;
  if (pictureField.data && pictureField.data.url) return pictureField.data.url;
  return null;
}

/**
 * GET /auth/facebook
 */
router.get('/facebook', (req, res) => {
  const client_id = getAppId();

  const params = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT_URI,
    scope: 'public_profile',
    response_type: 'code',
  });

  const url = `${FB_DIALOG}?${params.toString()}`;

  console.log('[Facebook OAuth] GET /auth/facebook → 302');
  console.log('[Facebook OAuth] client_id:', client_id);
  console.log('[Facebook OAuth] redirect_uri:', REDIRECT_URI);

  return res.redirect(302, url);
});

/**
 * GET /auth/facebook/callback
 */
router.get('/facebook/callback', async (req, res) => {
  console.log('[Facebook OAuth] GET /auth/facebook/callback');

  if (req.query.error) {
    const msg = req.query.error_description || req.query.error;
    console.error('[Facebook OAuth] error query:', msg);
    return res.status(400).json({
      success: false,
      error: String(req.query.error),
      message: String(msg),
    });
  }

  const code = req.query.code;
  if (!code) {
    console.log('[Facebook OAuth] missing code');
    return res.status(400).type('text/plain').send('No code received');
  }

  const appId = getAppId();
  const appSecret = getAppSecret();

  if (!appSecret) {
    console.error('[Facebook OAuth] FB_APP_SECRET missing');
    return res.status(500).json({
      success: false,
      error: 'server_config',
      message: 'FB_APP_SECRET is not configured',
    });
  }

  try {
    const tokenUrl = `${FB_GRAPH}/oauth/access_token`;
    console.log('[Facebook OAuth] exchanging code for access_token');

    const tokenRes = await axios.get(tokenUrl, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: REDIRECT_URI,
        code: String(code),
      },
      timeout: 25000,
      validateStatus: (s) => s < 500,
    });

    if (tokenRes.status !== 200 || !tokenRes.data?.access_token) {
      const fbErr =
        tokenRes.data?.error?.message ||
        tokenRes.data?.error_description ||
        JSON.stringify(tokenRes.data);
      console.error('[Facebook OAuth] token exchange failed:', fbErr);
      return res.status(400).json({
        success: false,
        error: 'token_exchange_failed',
        message: typeof fbErr === 'string' ? fbErr : JSON.stringify(fbErr),
      });
    }

    const accessToken = tokenRes.data.access_token;

    const meUrl = `${FB_GRAPH}/me`;
    console.log('[Facebook OAuth] fetching /me');

    const meRes = await axios.get(meUrl, {
      params: {
        fields: 'id,name,picture',
        access_token: accessToken,
      },
      timeout: 25000,
      validateStatus: (s) => s < 500,
    });

    if (meRes.status !== 200 || !meRes.data?.id) {
      const fbErr =
        meRes.data?.error?.message ||
        meRes.data?.error_description ||
        JSON.stringify(meRes.data);
      console.error('[Facebook OAuth] /me failed:', fbErr);
      return res.status(502).json({
        success: false,
        error: 'graph_me_failed',
        message: typeof fbErr === 'string' ? fbErr : JSON.stringify(fbErr),
      });
    }

    const u = meRes.data;
    const user = {
      id: u.id,
      name: u.name ?? null,
      picture: pictureUrlFromGraph(u.picture),
    };

    console.log('[Facebook OAuth] success user id:', user.id);

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    const detail =
      err.response?.data?.error?.message ||
      err.response?.data?.error_description ||
      err.response?.data ||
      err.message;
    console.error('[Facebook OAuth] exception:', detail);
    return res.status(502).json({
      success: false,
      error: 'facebook_api_error',
      message:
        typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
    });
  }
});

module.exports = router;
