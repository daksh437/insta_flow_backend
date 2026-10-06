/**
 * Server-side subscription entitlement: users/{uid}.entitlement (server-only,
 * Firestore rules block client writes).
 *
 *   active        subscription access right now (also checked against expiresAt)
 *   productId / basePlanId / offerId / state / latestOrderId
 *   isTrial       current period is the ₹5 intro (trial) period
 *   autoRenewing  will renew (false after the user cancels)
 *   expiresAt     end of the current period (Play expiryTime)
 *   renewalPrice  { currencyCode, units, nanos } of the next charge, from Play
 *   everPaid      the user has had a verified paid order (trial included).
 *                 Never-paid new users get the hard gate; everPaid users never
 *                 see it again (only reset if the trial order itself is refunded)
 *   source        'play' | 'admin_comp'
 *
 * Written by services/subscriptionSync.js (client activation + RTDN) and the
 * admin comp grant.
 */
const { getDb } = require('../utils/firestoreAdmin');
const { PLAN_CREDITS } = require('../config/credits');

const RECHECK_MS = 15 * 60 * 1000;

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

function everPaid(userDoc) {
  return !!(userDoc && userDoc.entitlement && userDoc.entitlement.everPaid === true);
}

/** Merge fields into users/{uid}.entitlement (nested merge keeps the rest). */
async function write(uid, fields) {
  await getDb().collection('users').doc(uid).set({
    entitlement: { ...fields, updatedAt: new Date() },
  }, { merge: true });
}

/**
 * Active entitlement for this user, re-syncing from Google Play when the stored
 * one is missing/expired but a verified plan receipt exists. A Play outage
 * never locks out a user whose receipt was verified before.
 * @returns {Promise<{active:boolean, expiresAtMillis:number|null}>}
 *   expiresAtMillis is null when unknown (e.g. Play outage).
 */
async function resolveActive(uid, userDoc) {
  if (isActive(userDoc)) return { active: true, expiresAtMillis: toMillis(userDoc.entitlement.expiresAt) };
  const inactive = { active: false, expiresAtMillis: null };
  const sub = userDoc && userDoc.subscription;
  if (!sub || !sub.purchaseToken || !PLAN_CREDITS[sub.productId]) return inactive;
  // RTDN keeps the entitlement current; re-ask Play at most every 15 minutes.
  const checkedAt = toMillis(userDoc.entitlement && userDoc.entitlement.updatedAt);
  if (checkedAt && Date.now() - checkedAt < RECHECK_MS) return inactive;
  const { syncSubscription } = require('./subscriptionSync');
  const r = await syncSubscription({ purchaseToken: sub.purchaseToken, productId: sub.productId, uid });
  if (r.status === 'synced') {
    return r.entitlement.active ? { active: true, expiresAtMillis: r.entitlement.expiresAtMillis } : inactive;
  }
  if (r.status === 'unavailable') return { active: sub.verified === true, expiresAtMillis: null };
  return inactive;
}

module.exports = { isActive, everPaid, write, resolveActive, toMillis };
