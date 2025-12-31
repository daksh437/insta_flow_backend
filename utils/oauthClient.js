const { google } = require('googleapis');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
} = process.env;

const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar',
];

function createOAuthClient() {
  const clientId = (GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = (GOOGLE_REDIRECT_URI || '').trim();
  
  if (!clientId || !clientSecret || !redirectUri) {
    const missing = [];
    if (!clientId) missing.push('GOOGLE_CLIENT_ID');
    if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
    if (!redirectUri) missing.push('GOOGLE_REDIRECT_URI');
    throw new Error(`Missing Google OAuth environment variables: ${missing.join(', ')}`);
  }
  
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function generateAuthUrl(userId) {
  try {
    const client = createOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state: userId || '', // Pass userId in state parameter for callback
    });
  } catch (error) {
    console.error('[generateAuthUrl] Error:', error.message);
    throw new Error(`Failed to generate auth URL: ${error.message}`);
  }
}

module.exports = {
  createOAuthClient,
  generateAuthUrl,
};

