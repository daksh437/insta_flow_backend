const express = require('express');

const router = express.Router();

/** Must match Meta → Facebook Login → Valid OAuth Redirect URIs exactly (HTTPS, no trailing slash). */
const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';

function getClientId() {
  return (process.env.FACEBOOK_APP_ID || '918884500687686').trim();
}

function getRedirectUri() {
  let u =
    process.env.FACEBOOK_REDIRECT_URI ||
    'https://insta-flow-backend.onrender.com/auth/facebook/callback';
  u = String(u).trim().replace(/\/$/, '');
  if (!u.startsWith('https://')) {
    console.error('[Facebook OAuth] redirect_uri must be HTTPS:', u);
  }
  return u;
}

/**
 * GET /auth/facebook
 * OAuth URL shape:
 * .../dialog/oauth?client_id=...&redirect_uri=...&scope=public_profile&response_type=code
 * Scope is ONLY public_profile (no email — avoids "Invalid Scopes: email" / App Review).
 */
router.get('/facebook', (req, res) => {
  const client_id = getClientId();
  const redirect_uri = getRedirectUri();
  const scope = 'public_profile';
  const response_type = 'code';

  const params = new URLSearchParams();
  params.set('client_id', client_id);
  params.set('redirect_uri', redirect_uri);
  params.set('scope', scope);
  params.set('response_type', response_type);

  const url = `${FB_DIALOG}?${params.toString()}`;

  console.log('[Facebook OAuth] GET /auth/facebook');
  console.log('[Facebook OAuth] client_id:', client_id);
  console.log('[Facebook OAuth] redirect_uri:', redirect_uri);
  console.log('[Facebook OAuth] scope:', scope, '(only — no email/pages/instagram)');
  console.log(
    '[Facebook OAuth] redirecting to dialog (pattern):',
    `${FB_DIALOG}?client_id=<APP_ID>&redirect_uri=<ENCODED>&scope=public_profile&response_type=code`,
  );

  return res.redirect(302, url);
});

/**
 * GET /auth/facebook/callback
 */
router.get('/facebook/callback', (req, res) => {
  console.log('[Facebook OAuth] GET /auth/facebook/callback');
  console.log('[Facebook OAuth] query keys:', Object.keys(req.query));

  const code = req.query.code;
  const err = req.query.error;
  const errDesc = req.query.error_description;

  if (err) {
    console.log('[Facebook OAuth] error from Facebook:', err, errDesc || '');
    return res
      .status(400)
      .type('text/plain')
      .send(`Facebook OAuth error: ${err}${errDesc ? ` — ${errDesc}` : ''}`);
  }

  if (!code) {
    console.log('[Facebook OAuth] missing code');
    return res.type('text/plain').send('No code received');
  }

  console.log('[Facebook OAuth] authorization code received (length):', String(code).length);
  return res
    .status(200)
    .type('text/plain')
    .send('Facebook login successful. Authorization completed.');
});

module.exports = router;
