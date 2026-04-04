const express = require('express');

const router = express.Router();

const FB_DIALOG = 'https://www.facebook.com/v19.0/dialog/oauth';

/** Must match Meta → Facebook Login → Valid OAuth Redirect URIs (HTTPS, exact). */
const REDIRECT_URI =
  'https://insta-flow-backend.onrender.com/auth/facebook/callback';

/**
 * GET /auth/facebook — redirect to Facebook OAuth dialog.
 */
router.get('/facebook', (req, res) => {
  const client_id = (process.env.FB_APP_ID || '').trim();

  if (!client_id) {
    console.error('[Facebook OAuth] FB_APP_ID is not set');
    return res.status(500).json({
      success: false,
      error: 'Server misconfiguration: FB_APP_ID is required',
    });
  }

  const params = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT_URI,
    scope: 'public_profile',
    response_type: 'code',
  });

  const url = `${FB_DIALOG}?${params.toString()}`;

  console.log('[Facebook OAuth] GET /auth/facebook → redirect');
  console.log('[Facebook OAuth] redirect_uri:', REDIRECT_URI);

  return res.redirect(302, url);
});

/**
 * GET /auth/facebook/callback — Facebook redirects here with ?code=...
 */
router.get('/facebook/callback', (req, res) => {
  const code = req.query.code;

  console.log('[Facebook OAuth] GET /auth/facebook/callback');

  if (!code) {
    console.log('[Facebook OAuth] no code in query');
    return res.type('text/plain').status(200).send('No code received');
  }

  console.log('[Facebook OAuth] code received');
  return res
    .type('text/plain')
    .status(200)
    .send(`Facebook login successful. Code: ${code}`);
});

module.exports = router;
