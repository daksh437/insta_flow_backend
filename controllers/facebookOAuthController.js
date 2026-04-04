/**
 * Facebook Login — OAuth 2.0 (authorization code).
 * GET /auth/facebook → redirect to dialog
 * GET /auth/facebook/callback → exchange code, return JSON
 */

const axios = require('axios');

const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';
const FB_GRAPH = 'https://graph.facebook.com/v19.0';

const DEFAULT_REDIRECT =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';

function normalizeRedirectUri() {
  let u = (process.env.FACEBOOK_REDIRECT_URI || DEFAULT_REDIRECT).trim();
  u = u.replace(/\/$/, '');
  if (!u.startsWith('https://')) {
    console.warn('[Facebook OAuth] redirect URI should use HTTPS in production');
  }
  return u;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * GET /auth/facebook — redirect browser to Facebook login
 */
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

  const scope = (
    process.env.FACEBOOK_SCOPES || 'email,public_profile'
  ).trim();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect_uri,
    response_type: 'code',
    scope,
  });

  const url = `${FB_DIALOG}?${params.toString()}`;
  console.log('[Facebook OAuth] redirecting to dialog');
  return res.redirect(302, url);
}

/**
 * GET /auth/facebook/callback — ?code=... or ?error=...
 */
async function facebookOAuthCallback(req, res) {
  const redirect_uri = normalizeRedirectUri();
  console.log('Redirect URI:', redirect_uri);

  const code = req.query.code;
  const oauthError = req.query.error;
  const errorDescription = req.query.error_description;

  if (oauthError) {
    console.log('[Facebook callback] OAuth error:', oauthError, errorDescription || '');
    const msg = errorDescription
      ? `${oauthError}: ${errorDescription}`
      : String(oauthError);
    return res.status(400).json({
      success: false,
      error: 'facebook_oauth_failed',
      message: msg,
    });
  }

  if (!code) {
    console.error('[Facebook callback] missing code');
    return res.status(400).json({
      success: false,
      error: 'missing_code',
      message: 'Authorization code not provided',
    });
  }

  const clientId = (process.env.FACEBOOK_APP_ID || '').trim();
  const clientSecret = (process.env.FACEBOOK_APP_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    console.error('[Facebook callback] FACEBOOK_APP_ID or FACEBOOK_APP_SECRET missing');
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

    console.log('[Facebook callback] token exchange OK');

    return res.status(200).json({
      success: true,
      message: 'Facebook login successful',
      access_token: data.access_token
        ? `${String(data.access_token).slice(0, 8)}…`
        : undefined,
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
