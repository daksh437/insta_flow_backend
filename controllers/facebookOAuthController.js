/**
 * Legacy — use routes/facebookAuth.js (mounted in app.js at /auth).
 */

const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';
const REDIRECT_URI =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';
const DEFAULT_FB_APP_ID = '2116455735836499';

function getAppId() {
  return (process.env.FB_APP_ID || DEFAULT_FB_APP_ID).trim();
}

function facebookOAuthStart(req, res) {
  const params = new URLSearchParams({
    client_id: getAppId(),
    redirect_uri: REDIRECT_URI,
    scope: 'public_profile',
    response_type: 'code',
  });
  return res.redirect(302, `${FB_DIALOG}?${params.toString()}`);
}

async function facebookOAuthCallback(req, res) {
  return res.status(410).json({
    success: false,
    message: 'Use routes/facebookAuth.js',
  });
}

module.exports = {
  facebookOAuthStart,
  facebookOAuthCallback,
};
