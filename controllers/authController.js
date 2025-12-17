const { createOAuthClient, generateAuthUrl } = require('../utils/oauthClient');
const { saveTokens, hasTokens } = require('../utils/tokenStore');

function getUserId(req) {
  const uid = req.headers['x-user-uid'] || req.query.userId || req.body?.userId;
  return uid;
}

async function getAuthUrl(req, res) {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID' });
    
    // Check if Google OAuth is configured
    if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID') {
      return res.status(400).json({ 
        success: false, 
        error: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env file' 
      });
    }
    
    const url = generateAuthUrl();
    res.json({ success: true, data: { url } });
  } catch (error) {
    console.error('getAuthUrl error', error);
    res.status(500).json({ success: false, error: 'Failed to generate auth URL' });
  }
}

async function handleCallback(req, res) {
  try {
    const code = req.query.code;
    const userId = getUserId(req);
    if (!code) return res.status(400).json({ success: false, error: 'Missing code' });
    if (!userId) return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID' });

    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens?.refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'No refresh_token returned. Ensure access_type=offline & prompt=consent',
      });
    }
    saveTokens(userId, tokens);
    res.json({ success: true, data: { connected: true } });
  } catch (error) {
    console.error('OAuth callback error', error);
    res.status(500).json({ success: false, error: 'OAuth callback failed' });
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

