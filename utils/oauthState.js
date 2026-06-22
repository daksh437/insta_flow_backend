const crypto = require('crypto');

const VERSION = 'v1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
let warnedWeakStateSecret = false;

function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64urlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function getStateSecret() {
  const direct = String(process.env.OAUTH_STATE_SECRET || process.env.STATE_SIGNING_SECRET || '').trim();
  if (direct) return direct;

  const fallback = String(process.env.GOOGLE_CLIENT_SECRET || process.env.INSTAGRAM_APP_SECRET || '').trim();
  if (!warnedWeakStateSecret && fallback) {
    warnedWeakStateSecret = true;
    console.warn('[oauthState] OAUTH_STATE_SECRET missing; using fallback secret. Set OAUTH_STATE_SECRET in production.');
  }
  return fallback;
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function createOAuthState(uid, provider, options = {}) {
  const secret = getStateSecret();
  if (!secret) throw new Error('Missing OAUTH_STATE_SECRET (or fallback secret)');
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  const now = Date.now();
  const payload = {
    uid: String(uid || '').trim(),
    provider: String(provider || 'unknown'),
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: now,
    exp: now + ttlMs,
  };
  if (!payload.uid) throw new Error('Cannot create OAuth state without uid');

  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${VERSION}.${payloadB64}.${sig}`;
}

function verifyOAuthState(state, expectedProvider) {
  const secret = getStateSecret();
  if (!secret) return { ok: false, code: 'OAUTH_STATE_SECRET_MISSING', message: 'State secret is not configured' };
  const raw = String(state || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { ok: false, code: 'INVALID_OAUTH_STATE', message: 'Malformed state parameter' };
  }
  const payloadB64 = parts[1];
  const providedSig = parts[2];
  const expectedSig = sign(payloadB64, secret);
  const validSig =
    providedSig.length === expectedSig.length &&
    crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
  if (!validSig) {
    return { ok: false, code: 'INVALID_OAUTH_STATE_SIGNATURE', message: 'State signature mismatch' };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch (_error) {
    return { ok: false, code: 'INVALID_OAUTH_STATE_PAYLOAD', message: 'State payload is invalid' };
  }
  const now = Date.now();
  if (!payload.exp || now > Number(payload.exp)) {
    return { ok: false, code: 'OAUTH_STATE_EXPIRED', message: 'State has expired' };
  }
  if (expectedProvider && payload.provider !== expectedProvider) {
    return { ok: false, code: 'OAUTH_PROVIDER_MISMATCH', message: 'State provider mismatch' };
  }
  const uid = String(payload.uid || '').trim();
  if (!uid) return { ok: false, code: 'OAUTH_STATE_UID_MISSING', message: 'State does not include uid' };
  return { ok: true, uid, payload };
}

module.exports = {
  createOAuthState,
  verifyOAuthState,
};
