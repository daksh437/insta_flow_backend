/**
 * Legacy Facebook OAuth helpers (not mounted by default — use routes/facebookAuth.js).
 * Scope MUST stay public_profile only unless App Review adds permissions.
 */

const axios = require('axios');

const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';
const FB_GRAPH = 'https://graph.facebook.com/v19.0';

const DEFAULT_REDIRECT =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';

function normalizeRedirectUri() {
  let u = (process.env.FACEBOOK_REDIRECT_URI || DEFAULT_REDIRECT).trim();
  u = u.replace(/\/$/, '');
  return u;
}

function facebookOAuthStart(req, res) {
  const redirect_uri = normalizeRedirectUri();
  console.log('Redirect URI:', redirect_uri);

  const clientId = (process.env.FACEBOOK_APP_ID || '').trim();
  if (!clientId) {
    return res.status(500).json({
      success: false,
      error: 'FACEBOOK_APP_ID is not configured',
    });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect_uri,
    response_type: 'code',
    scope: 'public_profile',
  });

  const url = `${FB_DIALOG}?${params.toString()}`;
  console.log('[Facebook OAuth] redirecting to dialog (scope=public_profile only)');
  return res.redirect(302, url);
}

async function facebookOAuthCallback(req, res) {
  const redirect_uri = normalizeRedirectUri();
  console.log('Redirect URI:', redirect_uri);

  const code = req.query.code;
  const oauthError = req.query.error;

  if (oauthError) {
    return res.status(400).json({
      success: false,
      error: 'facebook_oauth_failed',
      message: String(oauthError),
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      error: 'missing_code',
      message: 'Authorization code not provided',
    });
  }

  const clientId = (process.env.FACEBOOK_APP_ID || '').trim();
  const clientSecret = (process.env.FACEBOOK_APP_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      success: false,
      error: 'server_config',
      message: 'Facebook app credentials not configured on server',
    });
  }

  try {
    const tokenUrl = `${FB_GRAPH}/oauth/access_token`;
    const { data } = await axios.get(tokenUrl, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirect_uri,
        code,
      },
      timeout: 20000,
    });

    return res.status(200).json({
      success: true,
      message: 'Facebook login successful',
      token_type: data.token_type,
      expires_in: data.expires_in,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[Facebook callback] token exchange failed:', detail);
    return res.status(400).json({
      success: false,
      error: 'token_exchange_failed',
      message: typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
    });
  }
}

module.exports = {
  facebookOAuthStart,
  facebookOAuthCallback,
};
