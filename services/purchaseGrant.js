// Credit grants for Google Play purchases (credit plans + packs).
//
// RULE: no credits without verifying the purchase with the Google Play
// Developer API — purchases.subscriptionsv2.get for subscriptions,
// purchases.products.get for one-time packs. There is no fallback to the
// client's receipt:
//   - Play says the token is not a valid, paid purchase → grant nothing, log an error.
//   - Play can't be reached (5xx / network / auth misconfig) → grant nothing now,
//     queue the receipt and retry from a cron, so a paying user is never lost.
// Grants are idempotent per purchase (credit_grants doc keyed by token+product).

const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const { getPublisherApi, PACKAGE_NAME } = require('../utils/playVerify');
const creditService = require('./creditService');
const entitlement = require('./entitlement');
const cohort = require('./cohort');
const { PLAN_CREDITS, PACK_CREDITS, REFERRAL_PURCHASE_BONUS_PCT } = require('../config/credits');

const PENDING = 'pending_purchase_verifications';
const MAX_RETRY_MS = 48 * 60 * 60 * 1000;
const GRANTABLE_SUB_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function classifyApiError(e) {
  const status = e && e.response ? e.response.status : null;
  const message = (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message) || (e && e.message) || String(e);
  // 400/404/410: Play does not know this token for this app/product → not a real purchase.
  if (status === 400 || status === 404 || status === 410) return { status: 'invalid', reason: `play_${status}: ${message}` };
  // Everything else (5xx, network, 401/403 = API access misconfigured) is retryable.
  return { status: 'unavailable', reason: `play_${status || 'network'}: ${message}` };
}

/**
 * Ownership. The app attaches the uid at purchase time
 * (PurchaseParam.applicationUserName → obfuscatedExternalAccountId).
 *  - id present: it must equal the caller.
 *  - id absent (older purchases / no signed-in user at purchase): the first
 *    uid to claim the token owns it (purchase_tokens/{sha256(token)}, shared
 *    with the legacy premium path); any other uid is refused.
 * The token→uid claim is recorded in both cases.
 */
async function claimOwnership({ uid, purchaseToken, obfuscatedId }) {
  if (obfuscatedId && obfuscatedId !== uid) return { owned: false, reason: 'purchase belongs to another account (obfuscated id)' };
  const db = getDb();
  const ref = db.collection('purchase_tokens').doc(sha(String(purchaseToken)));
  const ownerUid = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, { uid, claimedAt: new Date(), via: obfuscatedId ? 'obfuscated_id' : 'first_claim' });
      return uid;
    }
    return snap.data().uid;
  });
  if (ownerUid !== uid) return { owned: false, reason: 'purchase token already claimed by another account' };
  return { owned: true };
}

/**
 * @returns {Promise<{status:'valid'|'invalid'|'unavailable', reason:string, orderId?:string}>}
 */
async function verifyPurchase({ uid, productId, purchaseToken }) {
  const api = getPublisherApi();
  try {
    if (PLAN_CREDITS[productId]) {
      const { data } = await api.purchases.subscriptionsv2.get({ packageName: PACKAGE_NAME, token: purchaseToken });
      const line = (data.lineItems || []).find((l) => l.productId === productId);
      if (!line) return { status: 'invalid', reason: `token is not for ${productId}` };
      const expiryMillis = Date.parse(line.expiryTime) || null;
      if (!GRANTABLE_SUB_STATES.has(data.subscriptionState)) return { status: 'invalid', reason: `subscriptionState=${data.subscriptionState}`, expiryMillis };
      const accountId = data.externalAccountIdentifiers && data.externalAccountIdentifiers.obfuscatedExternalAccountId;
      const own = await claimOwnership({ uid, purchaseToken, obfuscatedId: accountId });
      if (!own.owned) return { status: 'invalid', reason: own.reason };
      return { status: 'valid', reason: data.subscriptionState, orderId: line.latestSuccessfulOrderId || data.latestOrderId, expiryMillis };
    }
    if (PACK_CREDITS[productId]) {
      const { data } = await api.purchases.products.get({ packageName: PACKAGE_NAME, productId, token: purchaseToken });
      // purchaseState: 0 purchased, 1 canceled, 2 pending.
      if (data.purchaseState !== 0) return { status: 'invalid', reason: `purchaseState=${data.purchaseState}` };
      const own = await claimOwnership({ uid, purchaseToken, obfuscatedId: data.obfuscatedExternalAccountId });
      if (!own.owned) return { status: 'invalid', reason: own.reason };
      return { status: 'valid', reason: 'purchased', orderId: data.orderId };
    }
    return { status: 'invalid', reason: `unknown product ${productId}` };
  } catch (e) {
    return classifyApiError(e);
  }
}

// Play order ids: the first order of a subscription is "GPA.x", renewals are
// "GPA.x..0", "GPA.x..1", ... Packs have one order per token.
const isRenewalOrderId = (orderId) => /\.\.\d+$/.test(String(orderId || ''));

/**
 * Idempotent credit grant for ONE Play order (+ referral purchase bonus on the
 * first order of a token). Keyed by orderId, so every renewal grants exactly
 * once. The first order of a token is also recorded under the older
 * token+product key, so grants made before order keying are never repeated.
 * [amount] defaults to the plan/pack amount; [kind] is 'trial'|'plan'|'pack'.
 * Returns { granted, amount }.
 */
async function grantCredits({ uid, productId, purchaseToken, orderId, amount, kind }) {
  const db = getDb();
  const credits = amount ?? (PLAN_CREDITS[productId] || PACK_CREDITS[productId] || 0);
  if (!credits) return { granted: false, amount: 0 };
  const grants = db.collection('credit_grants');
  const legacyRef = grants.doc(sha(`${purchaseToken}:${productId}`));
  const firstOrder = !isRenewalOrderId(orderId);
  const orderRef = orderId ? grants.doc(sha(`order:${orderId}`)) : legacyRef;
  const grantKind = kind || (PACK_CREDITS[productId] ? 'pack' : 'plan');
  let referredByUid = null;
  let alreadyGranted = false;
  await db.runTransaction(async (tx) => {
    const g = await tx.get(orderRef);
    if (g.exists) { alreadyGranted = true; return; }
    if (firstOrder && orderRef !== legacyRef) {
      const legacy = await tx.get(legacyRef);
      if (legacy.exists) { alreadyGranted = true; return; }
    }
    const uref = db.collection('users').doc(uid);
    const usnap = await tx.get(uref);
    const cur = usnap.exists && typeof usnap.data().credits === 'number' ? usnap.data().credits : 0;
    referredByUid = usnap.exists ? (usnap.data().referredByUid || null) : null;
    const balanceAfter = cur + credits;
    const doc = { uid, productId, amount: credits, orderId: orderId || null, kind: grantKind, verified: true, at: new Date() };
    tx.set(uref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
    tx.set(orderRef, doc);
    if (firstOrder && orderRef !== legacyRef) tx.set(legacyRef, { ...doc, aliasOf: orderRef.id });
    creditService.recordTransactionInTx(tx, uid, {
      type: grantKind === 'trial' ? 'trial' : 'purchase',
      amount: credits,
      balanceAfter,
      description: grantKind === 'trial'
        ? 'Trial started'
        : (isRenewalOrderId(orderId) ? `Renewal ${productId}` : `Purchased ${productId}`),
      meta: { productId, orderId: orderId || null, kind: grantKind },
    });
  });
  if (alreadyGranted) return { granted: false, amount: credits };
  console.log(`[credits] verified ${grantKind} grant +${credits} to ${uid} (${productId} ${orderId || ''})`);
  if (firstOrder && referredByUid && referredByUid !== uid) {
    await grantReferralBonus({ referrerUid: referredByUid, buyerUid: uid, productId, purchaseToken, amount: credits });
  }
  return { granted: true, amount: credits };
}

async function grantReferralBonus({ referrerUid, buyerUid, productId, purchaseToken, amount }) {
  const bonus = Math.round(amount * REFERRAL_PURCHASE_BONUS_PCT);
  if (bonus <= 0) return;
  // New users (after RELEASE_AT) never receive free credits, referral bonuses included.
  if (await cohort.isNewUser(referrerUid)) {
    console.log(`[credits] referral purchase bonus skipped: referrer ${referrerUid} is a new user`);
    return;
  }
  const db = getDb();
  const refGrantRef = db.collection('credit_grants').doc(sha(`referral:${purchaseToken}:${productId}`));
  try {
    const admin = require('firebase-admin');
    await db.runTransaction(async (tx) => {
      const g = await tx.get(refGrantRef);
      if (g.exists) return;
      const rref = db.collection('users').doc(referrerUid);
      const rsnap = await tx.get(rref);
      const rcur = rsnap.exists && typeof rsnap.data().credits === 'number' ? rsnap.data().credits : 0;
      const rbalanceAfter = rcur + bonus;
      tx.set(rref, { credits: rbalanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
      tx.set(refGrantRef, {
        uid: referrerUid, productId, amount: bonus, at: new Date(),
        reason: 'referral_purchase_bonus', referredUid: buyerUid,
      });
      creditService.recordTransactionInTx(tx, referrerUid, {
        type: 'referral_purchase_bonus',
        amount: bonus,
        balanceAfter: rbalanceAfter,
        description: `Referral bonus — friend bought ${productId}`,
        meta: { productId, referredUid: buyerUid },
      });
      tx.set(db.collection('users').doc(referrerUid).collection('referrals').doc(buyerUid), {
        totalCreditsEarned: admin.firestore.FieldValue.increment(bonus),
      }, { merge: true });
    });
    console.log(`[credits] referral purchase bonus +${bonus} to ${referrerUid} (from ${buyerUid}'s ${productId})`);
  } catch (e) {
    console.warn('[credits] referral purchase bonus failed:', e.message);
  }
}

/**
 * Verify, then grant. Never grants on anything but a Play-verified purchase.
 * @returns {Promise<{status:'granted'|'already_granted'|'invalid'|'pending', amount?:number, reason?:string}>}
 */
async function verifyAndGrant({ uid, productId, purchaseToken }) {
  const pendingRef = getDb().collection(PENDING).doc(sha(`${purchaseToken}:${productId}`));
  let v;
  if (PLAN_CREDITS[productId]) {
    // Subscriptions: grant for the current order + entitlement, the same code
    // path as RTDN (services/subscriptionSync.js).
    const { syncSubscription } = require('./subscriptionSync');
    const r = await syncSubscription({ uid, productId, purchaseToken });
    if (r.status === 'synced' && r.paid) {
      await pendingRef.delete().catch(() => {});
      return {
        status: r.granted ? 'granted' : 'already_granted',
        amount: r.amount,
        isTrial: r.isTrial,
        orderId: r.orderId,
      };
    }
    v = r.status === 'synced' ? { status: 'invalid', reason: `subscriptionState=${r.state}` } : r;
  } else {
    v = await verifyPurchase({ uid, productId, purchaseToken });
    if (v.status === 'valid') {
      const g = await grantCredits({ uid, productId, purchaseToken, orderId: v.orderId, kind: 'pack' });
      await entitlement.write(uid, { everPaid: true });
      await pendingRef.delete().catch(() => {});
      return { status: g.granted ? 'granted' : 'already_granted', amount: g.amount };
    }
  }
  if (v.status === 'invalid') {
    console.error(`[credits] PURCHASE VERIFICATION FAILED uid=${uid} product=${productId}: ${v.reason} — no credits granted`);
    await pendingRef.delete().catch(() => {});
    return { status: 'invalid', reason: v.reason };
  }
  console.error(`[credits] Play API unavailable uid=${uid} product=${productId}: ${v.reason} — queued for retry, no credits granted yet`);
  const admin = require('firebase-admin');
  await pendingRef.set({
    uid, productId, purchaseToken,
    firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastError: v.reason,
    attempts: admin.firestore.FieldValue.increment(1),
  }, { merge: true });
  return { status: 'pending', reason: v.reason };
}

/** Cron: retry queued receipts whose verification hit a Play outage. */
async function retryPendingVerifications() {
  const db = getDb();
  if (!db) return;
  const snap = await db.collection(PENDING).limit(50).get();
  for (const d of snap.docs) {
    const p = d.data();
    const first = p.firstSeenAt && p.firstSeenAt.toDate ? p.firstSeenAt.toDate().getTime() : Date.now();
    if (Date.now() - first > MAX_RETRY_MS) {
      console.error(`[credits] giving up on unverifiable purchase uid=${p.uid} product=${p.productId}: ${p.lastError}`);
      await db.collection('purchase_verification_failures').doc(d.id).set({ ...p, gaveUpAt: new Date() });
      await d.ref.delete();
      continue;
    }
    try {
      await verifyAndGrant({ uid: p.uid, productId: p.productId, purchaseToken: p.purchaseToken });
    } catch (e) {
      console.warn('[credits] pending verification retry error:', e.message);
    }
  }
}

module.exports = {
  verifyPurchase,
  verifyAndGrant,
  retryPendingVerifications,
  grantCredits,
  claimOwnership,
  classifyApiError,
  isRenewalOrderId,
  GRANTABLE_SUB_STATES,
  PENDING,
  sha,
};
