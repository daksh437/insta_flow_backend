/**
 * Verifies the OIDC token Google Pub/Sub attaches to push requests
 * (Authorization: Bearer <JWT>), so only our own push subscription can call
 * /play/rtdn. Configure on Render:
 *   RTDN_AUDIENCE       the audience set on the push subscription
 *                       (e.g. https://insta-flow-backend.onrender.com/play/rtdn)
 *   RTDN_PUSH_SA_EMAIL  the service account the push subscription signs as
 * Without both, every push is rejected (fail closed).
 */
const { google } = require('googleapis');

let client = null;

function config() {
  return {
    audience: String(process.env.RTDN_AUDIENCE || '').trim(),
    email: String(process.env.RTDN_PUSH_SA_EMAIL || '').trim().toLowerCase(),
  };
}

/** @returns {Promise<{ok:boolean, reason?:string}>} */
async function verifyPushRequest(req) {
  const { audience, email } = config();
  if (!audience || !email) return { ok: false, reason: 'RTDN_AUDIENCE / RTDN_PUSH_SA_EMAIL not configured' };
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return { ok: false, reason: 'missing bearer token' };
  try {
    client = client || new google.auth.OAuth2();
    const ticket = await client.verifyIdToken({ idToken: m[1], audience });
    const p = ticket.getPayload() || {};
    if (String(p.email || '').toLowerCase() !== email || p.email_verified !== true) {
      return { ok: false, reason: `unexpected signer ${p.email || '?'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `invalid token: ${e.message}` };
  }
}

module.exports = { verifyPushRequest };
