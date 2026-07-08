/**
 * Google Play Developer API — verify a subscription purchase token.
 *
 * Uses the same service account as Firestore Admin (FIREBASE_SERVICE_ACCOUNT_JSON
 * or GOOGLE_APPLICATION_CREDENTIALS). That service account must be granted access
 * in Google Play Console → Setup → API access (link the Cloud project and give
 * the account "View financial data / Manage orders & subscriptions"), and the
 * "Google Play Android Developer API" must be enabled in Google Cloud.
 *
 * verify=false means the API could not be reached (not configured / error) — the
 * caller should fall back to the receipt so activation still works meanwhile.
 */
const { google } = require('googleapis');

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.instaflow';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

let _api = null;
function getApi() {
  if (_api) return _api;
  let credentials = null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    try {
      credentials = JSON.parse(raw);
    } catch (_) {
      /* ignore — fall back to GOOGLE_APPLICATION_CREDENTIALS */
    }
  }
  const auth = credentials
    ? new google.auth.GoogleAuth({ credentials, scopes: [SCOPE] })
    : new google.auth.GoogleAuth({ scopes: [SCOPE] });
  _api = google.androidpublisher({ version: 'v3', auth });
  return _api;
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

module.exports = { verifySubscription, PACKAGE_NAME };
