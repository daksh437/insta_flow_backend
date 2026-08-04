const { createOAuthClient, generateAuthUrl } = require('../utils/oauthClient');
const { saveTokens, hasTokens } = require('../utils/tokenStore');
const { escapeHtml } = require('../utils/html');
const { createOAuthState, verifyOAuthState } = require('../utils/oauthState');
const { apiSuccess, apiError, toSafeError } = require('../utils/response');

function getUserId(req) {
  // req.uid is set by the requireAuth middleware (verified Firebase ID
  // token) on routes that carry it — see routes/auth.js. redirectGoogleOAuth
  // is a raw browser redirect (no Authorization header possible) and is the
  // only caller that still falls back to the query param below.
  if (req.uid) return req.uid;
  return req.query.userId || req.body?.userId;
}

async function getAuthUrl(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) {
      console.error('[getAuthUrl] Missing userId/Firebase UID');
      return apiError(res, 400, 'MISSING_USER_ID', 'Missing userId/Firebase UID. Please login first.');
    }
    
    // Check if Google OAuth is configured (check for missing or empty values)
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    
    if (!clientId || !clientSecret || !redirectUri) {
      console.error('[getAuthUrl] Google OAuth not configured - missing or empty values');
      console.error('[getAuthUrl] GOOGLE_CLIENT_ID:', clientId ? '***set***' : 'MISSING');
      console.error('[getAuthUrl] GOOGLE_CLIENT_SECRET:', clientSecret ? '***set***' : 'MISSING');
      console.error('[getAuthUrl] GOOGLE_REDIRECT_URI:', redirectUri ? redirectUri : 'MISSING');
      return apiError(
        res,
        500,
        'GOOGLE_OAUTH_NOT_CONFIGURED',
        'Google OAuth not configured. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in environment variables.'
      );
    }
    
    if (clientId === 'YOUR_GOOGLE_CLIENT_ID' || 
        clientSecret === 'YOUR_GOOGLE_CLIENT_SECRET' ||
        redirectUri === 'YOUR_GOOGLE_REDIRECT_URI') {
      console.error('[getAuthUrl] Google OAuth using placeholder values');
      return apiError(
        res,
        500,
        'GOOGLE_OAUTH_PLACEHOLDER_CONFIG',
        'Google OAuth not configured. Please set real GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI values.'
      );
    }
    
    console.log('[getAuthUrl] Generating auth URL for userId:', userId);
    const state = createOAuthState(userId, 'google');
    const url = generateAuthUrl(state);
    console.log('[getAuthUrl] Auth URL generated successfully');
    return apiSuccess(res, { url });
  } catch (error) {
    console.error('[getAuthUrl] Error:', error.message);
    console.error('[getAuthUrl] Stack:', error.stack);
    const safe = toSafeError(error, 'Failed to generate auth URL', 'OAUTH_URL_FAILED');
    return apiError(res, safe.status, safe.code, safe.message);
  }
}

async function handleCallback(req, res) {
  try {
    const code = req.query.code;
    const state = req.query.state;
    const stateResult = verifyOAuthState(state, 'google');
    const userId = stateResult.ok ? stateResult.uid : null;
    
    console.log('[handleCallback] Received callback - code:', code ? 'present' : 'missing', 'userId:', userId || 'missing');
    console.log('[handleCallback] Query params:', { code: code ? 'present' : 'missing', state: req.query.state });
    
    if (!code) {
      console.error('[handleCallback] Missing OAuth code');
      return apiError(res, 400, 'MISSING_OAUTH_CODE', 'Missing OAuth authorization code');
    }
    
    if (!userId) {
      console.error('[handleCallback] Missing userId - state param:', req.query.state, 'headers:', Object.keys(req.headers).filter(k => k.toLowerCase().includes('user')));
      return apiError(
        res,
        400,
        stateResult.code || 'INVALID_OAUTH_STATE',
        stateResult.message || 'Missing userId/Firebase UID. Please ensure you are logged in and try connecting again.'
      );
    }

    console.log('[handleCallback] Exchanging code for tokens for userId:', userId);
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    
    if (!tokens?.refresh_token) {
      console.error('[handleCallback] No refresh_token received');
      return apiError(res, 400, 'MISSING_REFRESH_TOKEN', 'No refresh_token returned. Ensure access_type=offline & prompt=consent');
    }
    
    console.log('[handleCallback] Tokens received, saving for userId:', userId);
    await saveTokens(userId, tokens);
    
    // Return success page that can be displayed in browser
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Calendar Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 40px;
              background: rgba(255, 255, 255, 0.1);
              border-radius: 20px;
              backdrop-filter: blur(10px);
            }
            h1 { margin: 0 0 20px 0; font-size: 28px; }
            p { margin: 10px 0; font-size: 16px; opacity: 0.9; }
            .checkmark { font-size: 64px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="checkmark">✅</div>
            <h1>Google Calendar Connected!</h1>
            <p>You can now close this window and return to the app.</p>
            <p>Your calendar is ready to use.</p>
          </div>
          <script>
            // Try to close the window after 2 seconds (may not work on all browsers)
            setTimeout(() => {
              if (window.opener) {
                window.close();
              }
            }, 2000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('[handleCallback] OAuth callback error:', error.message);
    console.error('[handleCallback] Stack:', error.stack);
    const safeErrorMessage = escapeHtml(error.message || 'An error occurred while connecting to Google Calendar.');
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connection Failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 40px;
              background: rgba(255, 255, 255, 0.1);
              border-radius: 20px;
              backdrop-filter: blur(10px);
            }
            h1 { margin: 0 0 20px 0; font-size: 28px; }
            p { margin: 10px 0; font-size: 16px; opacity: 0.9; }
            .error { font-size: 64px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error">❌</div>
            <h1>Connection Failed</h1>
            <p>${safeErrorMessage}</p>
            <p>Please try again from the app.</p>
          </div>
        </body>
      </html>
    `);
  }
}

async function getStatus(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) return apiError(res, 400, 'MISSING_USER_ID', 'Missing userId/Firebase UID');
    const connected = await hasTokens(userId);
    return apiSuccess(res, { connected });
  } catch (error) {
    console.error('getStatus error', error);
    return apiError(res, 500, 'STATUS_CHECK_FAILED', 'Status check failed');
  }
}

/**
 * GET /auth/google?userId= — browser redirect to Google OAuth (state = userId).
 */
async function redirectGoogleOAuth(req, res) {
  try {
    const userId = req.query.userId || getUserId(req);
    if (!userId) {
      return res
        .status(400)
        .send(
          '<!DOCTYPE html><html><body><p>Missing userId. Open this link from the InstaFlow app after signing in.</p></body></html>'
        );
    }
    const state = createOAuthState(userId, 'google');
    const url = generateAuthUrl(state);
    return res.redirect(302, url);
  } catch (error) {
    console.error('[redirectGoogleOAuth]', error.message);
    return res.status(500).send(`<html><body><p>${error.message || 'OAuth redirect failed'}</p></body></html>`);
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getStatus,
  redirectGoogleOAuth,
};

