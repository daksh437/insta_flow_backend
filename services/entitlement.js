/**
 * Server-side subscription entitlement: users/{uid}.entitlement
 *   { active, productId, expiresAt, state, source, updatedAt }
 * Server-only (Firestore rules block client writes). Written when Google Play
 * verifies a plan purchase, and refreshed from Play when it looks expired
 * (RTDN will keep it current once that phase ships).
 */
const { getDb } = require('../utils/firestoreAdmin');
const { PLAN_CREDITS } = require('../config/credits');

const toMillis = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};

function isActive(userDoc, now = Date.now()) {
  const e = userDoc && userDoc.entitlement;
  return !!(e && e.active === true && toMillis(e.expiresAt) > now);
}

async function record(uid, { productId, expiryMillis, state, active = true }) {
  await getDb().collection('users').doc(uid).set({
    entitlement: {
      active: active && Number.isFinite(expiryMillis) && expiryMillis > Date.now(),
      productId,
      expiresAt: Number.isFinite(expiryMillis) ? new Date(expiryMillis) : null,
      state: state || null,
      source: 'play_verify',
      updatedAt: new Date(),
    },
  }, { merge: true });
}

/**
 * Active entitlement for this user, re-checking Google Play when the stored one
 * is missing/expired but a verified plan receipt exists. A Play outage never
 * locks out a user whose receipt was verified before.
 */
async function resolveActive(uid, userDoc) {
  if (isActive(userDoc)) return true;
  const sub = userDoc && userDoc.subscription;
  if (!sub || !sub.purchaseToken || !PLAN_CREDITS[sub.productId]) return false;
  const { verifyPurchase } = require('./purchaseGrant');
  const v = await verifyPurchase({ uid, productId: sub.productId, purchaseToken: sub.purchaseToken });
  if (v.status === 'valid') {
    await record(uid, { productId: sub.productId, expiryMillis: v.expiryMillis, state: v.reason });
    return Number.isFinite(v.expiryMillis) && v.expiryMillis > Date.now();
  }
  if (v.status === 'invalid') {
    await record(uid, { productId: sub.productId, expiryMillis: v.expiryMillis, state: v.reason, active: false });
    return false;
  }
  return sub.verified === true;
}

module.exports = { isActive, record, resolveActive, toMillis };
