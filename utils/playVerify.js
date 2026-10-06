/**
 * Google Play Developer API — verify a subscription purchase token.
 *
 * Uses the same service account as Firestore Admin (FIREBASE_SERVICE_ACCOUNT_JSON
 * or GOOGLE_APPLICATION_CREDENTIALS). That service account must be granted access
 * in Google Play Console → Setup → API access (link the Cloud project and give
 * the account "View financial data / Manage orders & subscriptions"), and the
 * "Google Play Android Developer API" must be enabled in Google Cloud.
 *
 * verify=false means the API could not be reached (not configured / error). Callers
 * must NOT grant anything in that case (see services/purchaseGrant.js).
 */
const { google } = require('googleapis');

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.instaflow';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

let _api = null;
let _credentialInfo = null;

/**
 * Credentials (same service account as Firestore Admin):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON — the service-account JSON as a string
 *   2. GOOGLE_APPLICATION_CREDENTIALS — path to a service-account JSON file
 * The private key gets the same escaped-newline fix firestoreAdmin.js applies,
 * so a key that works for Firestore also works here.
 */
function loadCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      const c = JSON.parse(raw);
      if (typeof c.private_key === 'string') c.private_key = c.private_key.replace(/\\n/g, '\n');
      return { credentials: c, source: 'FIREBASE_SERVICE_ACCOUNT_JSON', clientEmail: c.client_email || null };
    } catch (e) {
      return { credentials: null, source: 'FIREBASE_SERVICE_ACCOUNT_JSON (invalid JSON)', clientEmail: null, error: e.message };
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    let clientEmail = null;
    try { clientEmail = require(process.env.GOOGLE_APPLICATION_CREDENTIALS).client_email || null; } catch (_) { /* reported by the check */ }
    return { credentials: null, source: 'GOOGLE_APPLICATION_CREDENTIALS', clientEmail };
  }
  return { credentials: null, source: 'none', clientEmail: null };
}

function getApi() {
  if (_api) return _api;
  _credentialInfo = loadCredentials();
  const auth = _credentialInfo.credentials
    ? new google.auth.GoogleAuth({ credentials: _credentialInfo.credentials, scopes: [SCOPE] })
    : new google.auth.GoogleAuth({ scopes: [SCOPE] });
  _api = google.androidpublisher({ version: 'v3', auth });
  return _api;
}

/**
 * Self-check: can this server actually use the Play Developer API for our app?
 *  - monetization.subscriptions.list → the account can see the app's products
 *  - purchases.subscriptionsv2.get with a dummy token → must answer 400
 *    ("invalid token"); 401/403 means the account lacks the purchase/financial
 *    permission, so no purchase could ever be verified.
 * Never returns secrets (only the service-account email).
 */
async function checkPlayAccess() {
  const api = getApi();
  const info = _credentialInfo || loadCredentials();
  const checks = [];
  const statusOf = (e) => (e && e.response ? e.response.status : null);
  const msgOf = (e) => (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || String(e);

  try {
    const r = await api.monetization.subscriptions.list({ packageName: PACKAGE_NAME });
    const ids = (r.data.subscriptions || []).map((x) => x.productId);
    checks.push({ name: 'list_subscriptions', ok: ids.length > 0, status: 200, detail: ids.join(', ') || 'no subscriptions returned' });
  } catch (e) {
    checks.push({ name: 'list_subscriptions', ok: false, status: statusOf(e), detail: msgOf(e) });
  }
  try {
    await api.purchases.subscriptionsv2.get({ packageName: PACKAGE_NAME, token: 'health-check-invalid-token' });
    checks.push({ name: 'verify_purchase_permission', ok: true, status: 200, detail: 'unexpected 200 for a dummy token' });
  } catch (e) {
    const st = statusOf(e);
    checks.push({
      name: 'verify_purchase_permission',
      ok: st === 400 || st === 404,
      status: st,
      detail: st === 400 || st === 404 ? 'authorized (dummy token rejected as expected)' : msgOf(e),
    });
  }
  return {
    ok: checks.every((c) => c.ok),
    packageName: PACKAGE_NAME,
    credentialSource: info.source,
    serviceAccount: info.clientEmail,
    checks,
  };
}

/**
 * @returns {Promise<{verified:boolean, active:boolean, expiryMillis:number,
 *   autoRenewing?:boolean, paymentState?:number, reason:string, error?:string}>}
 */
async function verifySubscription(productId, purchaseToken) {
  if (!productId || !purchaseToken) {
    return { verified: false, active: false, expiryMillis: 0, reason: 'missing_args' };
  }
  try {
    const api = getApi();
    const res = await api.purchases.subscriptions.get({
      packageName: PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
    });
    const d = res.data || {};
    const expiryMillis = d.expiryTimeMillis ? Number(d.expiryTimeMillis) : 0;
    // paymentState: 0 pending, 1 received, 2 free-trial, 3 pending deferred.
    const paymentState = typeof d.paymentState === 'number' ? d.paymentState : null;
    const notExpired = expiryMillis > Date.now();
    const paidOrTrial = paymentState === 1 || paymentState === 2 || paymentState === null;
    const active = notExpired && paidOrTrial;
    return {
      verified: true,
      active,
      expiryMillis,
      autoRenewing: d.autoRenewing === true,
      paymentState,
      reason: active ? 'active' : 'inactive_or_expired',
    };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.warn('[playVerify] subscription verify failed (fallback to receipt):', msg);
    return { verified: false, active: false, expiryMillis: 0, reason: 'api_error', error: msg };
  }
}

module.exports = { verifySubscription, PACKAGE_NAME, getPublisherApi: getApi, checkPlayAccess };
