const { createOAuthClient, generateAuthUrl } = require('../utils/oauthClient');
const { saveTokens, hasTokens } = require('../utils/tokenStore');

function getUserId(req) {
  // Try multiple header name variations (case-insensitive)
  const uid = req.headers['x-user-uid'] || 
              req.headers['X-User-UID'] || 
              req.headers['x-user-id'] || 
              req.headers['X-User-Id'] ||
              req.query.userId || 
              req.body?.userId;
  
  // Log for debugging
  if (!uid) {
    console.log('[getUserId] No userId found. Headers:', Object.keys(req.headers).filter(k => k.toLowerCase().includes('user')));
    console.log('[getUserId] Query:', req.query);
    console.log('[getUserId] Body:', req.body);
  }
  
  return uid;
}

async function getAuthUrl(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) {
      console.error('[getAuthUrl] Missing userId/Firebase UID');
      return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID. Please login first.' });
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
      return res.status(500).json({ 
        success: false, 
        error: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Render.com environment variables.' 
      });
    }
    
    if (clientId === 'YOUR_GOOGLE_CLIENT_ID' || 
        clientSecret === 'YOUR_GOOGLE_CLIENT_SECRET' ||
        redirectUri === 'YOUR_GOOGLE_REDIRECT_URI') {
      console.error('[getAuthUrl] Google OAuth using placeholder values');
      return res.status(500).json({ 
        success: false, 
        error: 'Google OAuth not configured. Please set real GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI values in Render.com environment variables.' 
      });
    }
    
    console.log('[getAuthUrl] Generating auth URL for userId:', userId);
    const url = generateAuthUrl(userId); // Pass userId to include in state parameter
    console.log('[getAuthUrl] Auth URL generated successfully');
    res.json({ success: true, data: { url } });
  } catch (error) {
    console.error('[getAuthUrl] Error:', error.message);
    console.error('[getAuthUrl] Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: `Failed to generate auth URL: ${error.message}` 
    });
  }
}

async function handleCallback(req, res) {
  try {
    const code = req.query.code;
    // Get userId from state parameter (passed in OAuth URL) or from headers/query
    const userId = req.query.state || getUserId(req);
    
    console.log('[handleCallback] Received callback - code:', code ? 'present' : 'missing', 'userId:', userId || 'missing');
    console.log('[handleCallback] Query params:', { code: code ? 'present' : 'missing', state: req.query.state });
    
    if (!code) {
      console.error('[handleCallback] Missing OAuth code');
      return res.status(400).json({ success: false, error: 'Missing OAuth authorization code' });
    }
    
    if (!userId) {
      console.error('[handleCallback] Missing userId - state param:', req.query.state, 'headers:', Object.keys(req.headers).filter(k => k.toLowerCase().includes('user')));
      return res.status(400).json({ 
        success: false, 
        error: 'Missing userId/Firebase UID. Please ensure you are logged in and try connecting again.' 
      });
    }

    console.log('[handleCallback] Exchanging code for tokens for userId:', userId);
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    
    if (!tokens?.refresh_token) {
      console.error('[handleCallback] No refresh_token received');
      return res.status(400).json({
        success: false,
        error: 'No refresh_token returned. Ensure access_type=offline & prompt=consent',
      });
    }
    
    console.log('[handleCallback] Tokens received, saving for userId:', userId);
    saveTokens(userId, tokens);
    
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
            <p>${error.message || 'An error occurred while connecting to Google Calendar.'}</p>
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
    if (!userId) return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID' });
    const connected = hasTokens(userId);
    res.json({ success: true, data: { connected } });
  } catch (error) {
    console.error('getStatus error', error);
    res.status(500).json({ success: false, error: 'Status check failed' });
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getStatus,
};

