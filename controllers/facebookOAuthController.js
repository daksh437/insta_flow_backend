/**
 * Facebook / Meta Login — redirect_uri handler.
 * GET /auth/callback?code=...&state=...
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function facebookOAuthCallback(req, res) {
  const code = req.query.code;
  const oauthError = req.query.error;
  const errorDescription = req.query.error_description;

  if (oauthError) {
    console.log('[auth/callback] Facebook OAuth error:', oauthError, errorDescription || '');
    const msg = errorDescription
      ? `${oauthError}: ${errorDescription}`
      : String(oauthError);
    return res.status(400).type('html').send(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Login failed</title></head><body><p>Login failed: ${escapeHtml(msg)}</p></body></html>`,
    );
  }

  if (!code) {
    console.error('[auth/callback] Missing required query param: code');
    return res.status(400).type('html').send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Login failed</title></head><body><p>Missing authorization code.</p></body></html>',
    );
  }

  console.log('[auth/callback] OAuth code received:', code);

  return res.type('html').send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Login Success</title></head><body><p>Login Success, you can close this page</p></body></html>',
  );
}

module.exports = {
  facebookOAuthCallback,
};
