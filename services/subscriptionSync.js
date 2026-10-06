/**
 * One code path for subscription state, used by client activation
 * (/activate-premium) and Google Play RTDN (/play/rtdn):
 *
 *   Play purchases.subscriptionsv2.get
 *     → who owns it (obfuscatedExternalAccountId, else the first-claim record,
 *       else the token it replaced via linkedPurchaseToken)
 *     → credits for the current order, once per orderId:
 *         trial order (₹5 intro, offer trial-3days) → TRIAL_CREDITS
 *         any later paid order (conversion, renewals) → PLAN_CREDITS
 *     → users/{uid}.entitlement (see services/entitlement.js)
 *     → trial reminder schedule (trial_reminders/{uid})
 *
 * Refunds/chargebacks (voided purchases) claw back that order's credits.
 */
const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const { getPublisherApi, PACKAGE_NAME } = require('../utils/playVerify');
const creditService = require('./creditService');
const entitlement = require('./entitlement');
const { PLAN_CREDITS, TRIAL_OFFER_ID, TRIAL_CREDITS } = require('../config/credits');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ACTIVE_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;
const TRIAL_REMINDERS = 'trial_reminders';

/** False for a deleted account (tombstone) or a missing user document. */
async function accountExists(uid) {
  const db = getDb();
  const [tomb, user] = await Promise.all([
    db.collection('deleted_users').doc(uid).get(),
    db.collection('users').doc(uid).get(),
  ]);
  return !tomb.exists && user.exists;
}

function grantModule() {
  return require('./purchaseGrant'); // lazy: purchaseGrant requires this module too
}

/** The current period is the ₹5 intro (trial) period of offer trial-3days. */
function isTrialPeriod(line, orderId) {
  const offerId = line && line.offerDetails && line.offerDetails.offerId;
  if (offerId !== TRIAL_OFFER_ID) return false;
  const phase = line.offerPhase;
  if (phase && typeof phase === 'object') return !!(phase.introductoryPrice || phase.freeTrial);
  // Older API responses without offerPhase: the trial is the first order.
  return !grantModule().isRenewalOrderId(orderId);
}

/**
 * Access for the current period. CANCELED = auto-renew off but paid until
 * expiry; IN_GRACE_PERIOD = payment retrying, keep access.
 */
function periodState(data, line, now = Date.now()) {
  const state = data.subscriptionState;
  const expiryMillis = Date.parse(line.expiryTime) || null;
  const inPeriod = Number.isFinite(expiryMillis) && expiryMillis > now;
  const paid = inPeriod && (ACTIVE_STATES.has(state) || state === 'SUBSCRIPTION_STATE_CANCELED');
  return { state, expiryMillis, paid, active: paid };
}

async function fetchSubscription(purchaseToken) {
  try {
    const { data } = await getPublisherApi().purchases.subscriptionsv2.get({ packageName: PACKAGE_NAME, token: purchaseToken });
    return { status: 'ok', data };
  } catch (e) {
    return grantModule().classifyApiError(e);
  }
}

/**
 * Owner of a subscription token. With [uidHint] (client activation) the
 * caller must be the owner; without it (RTDN) the owner is looked up.
 * @returns {Promise<{uid:string|null, reason?:string}>}
 */
async function resolveOwner({ data, purchaseToken, uidHint }) {
  const { claimOwnership } = grantModule();
  const db = getDb();
  const obfuscated = data.externalAccountIdentifiers && data.externalAccountIdentifiers.obfuscatedExternalAccountId;
  if (uidHint) {
    const own = await claimOwnership({ uid: uidHint, purchaseToken, obfuscatedId: obfuscated });
    return own.owned ? { uid: uidHint } : { uid: null, reason: own.reason };
  }
  if (obfuscated) {
    const own = await claimOwnership({ uid: obfuscated, purchaseToken, obfuscatedId: obfuscated });
    return own.owned ? { uid: obfuscated } : { uid: null, reason: own.reason };
  }
  const claim = await db.collection('purchase_tokens').doc(sha(purchaseToken)).get();
  if (claim.exists) return { uid: claim.data().uid };
  if (data.linkedPurchaseToken) {
    // Upgrade/downgrade/resubscribe: the new token belongs to the old token's owner.
    const prev = await db.collection('purchase_tokens').doc(sha(data.linkedPurchaseToken)).get();
    if (prev.exists) {
      const prevUid = prev.data().uid;
      const own = await claimOwnership({ uid: prevUid, purchaseToken, obfuscatedId: null });
      if (own.owned) return { uid: prevUid };
    }
  }
  return { uid: null, reason: 'no owner known for this token yet' };
}

function renewalPriceOf(line) {
  const p = line.autoRenewingPlan && line.autoRenewingPlan.recurringPrice;
  return p && p.currencyCode ? { currencyCode: p.currencyCode, units: String(p.units || '0'), nanos: Number(p.nanos || 0) } : null;
}

/**
 * Sync one subscription token into credits + entitlement.
 * @returns {Promise<
 *   {status:'synced', uid, paid, active, state, isTrial, orderId, granted, amount, entitlement:{active, expiresAtMillis}}
 *   | {status:'invalid'|'unavailable'|'unowned', reason}>}
 */
async function syncSubscription({ purchaseToken, productId, uid: uidHint }) {
  const fetched = await fetchSubscription(purchaseToken);
  if (fetched.status !== 'ok') return fetched;
  const data = fetched.data || {};
  const lines = data.lineItems || [];
  const line = productId ? lines.find((l) => l.productId === productId) : lines.find((l) => PLAN_CREDITS[l.productId]);
  if (!line) return { status: 'invalid', reason: productId ? `token is not for ${productId}` : 'no known plan in token' };

  const owner = await resolveOwner({ data, purchaseToken, uidHint });
  if (!owner.uid) return { status: uidHint ? 'invalid' : 'unowned', reason: owner.reason };
  const uid = owner.uid;
  if (!(await accountExists(uid))) {
    console.warn(`[subscriptionSync] owner ${uid} was deleted — skipping, nothing written`);
    return { status: 'deleted_user', uid };
  }

  const orderId = line.latestSuccessfulOrderId || data.latestOrderId || null;
  const { state, expiryMillis, paid, active } = periodState(data, line);
  const isTrial = isTrialPeriod(line, orderId);

  let granted = false;
  let amount = 0;
  if (paid) {
    const g = await grantModule().grantCredits({
      uid,
      productId: line.productId,
      purchaseToken,
      orderId,
      amount: isTrial ? TRIAL_CREDITS : PLAN_CREDITS[line.productId],
      kind: isTrial ? 'trial' : 'plan',
    });
    granted = g.granted;
    amount = g.amount;
  }

  const autoRenewing = !!(line.autoRenewingPlan && line.autoRenewingPlan.autoRenewEnabled);
  const fields = {
    active,
    productId: line.productId,
    basePlanId: (line.offerDetails && line.offerDetails.basePlanId) || null,
    offerId: (line.offerDetails && line.offerDetails.offerId) || null,
    state,
    isTrial: isTrial && active,
    autoRenewing,
    expiresAt: expiryMillis ? new Date(expiryMillis) : null,
    latestOrderId: orderId,
    renewalPrice: renewalPriceOf(line),
    source: 'play',
  };
  if (paid) fields.everPaid = true;
  if (isTrial && paid) fields.trialUsed = true;
  await entitlement.write(uid, fields);
  if (paid) {
    await getDb().collection('users').doc(uid).set({
      subscription: { productId: line.productId, purchaseToken, verified: true, updatedAt: new Date(), platform: 'android' },
    }, { merge: true });
  }
  await scheduleTrialReminder(uid, { isTrial: isTrial && active, autoRenewing, expiryMillis, orderId });

  return {
    status: 'synced', uid, paid, active, state, isTrial, orderId, granted, amount,
    entitlement: { active, expiresAtMillis: expiryMillis },
  };
}

/** One reminder per trial, 24h before it converts; cleared otherwise. */
async function scheduleTrialReminder(uid, { isTrial, autoRenewing, expiryMillis, orderId }) {
  const ref = getDb().collection(TRIAL_REMINDERS).doc(uid);
  if (isTrial && autoRenewing && expiryMillis) {
    const existing = await ref.get();
    if (existing.exists && existing.data().orderId === orderId) return;
    await ref.set({ uid, orderId, expiresAt: new Date(expiryMillis), dueAt: new Date(expiryMillis - REMINDER_LEAD_MS) });
  } else {
    await ref.delete().catch(() => {});
  }
}

/**
 * Refund / chargeback of one order (RTDN voidedPurchaseNotification or
 * SUBSCRIPTION_REVOKED). Deducts that order's credits (floor 0, ledger entry),
 * once. A refunded trial order makes the user "never paid" again (hard gate),
 * unless another paid order of theirs still stands.
 */
async function handleVoided({ purchaseToken, orderId }) {
  const db = getDb();
  if (!orderId) return { status: 'ignored', reason: 'no orderId' };
  const snap = await db.collection('credit_grants').where('orderId', '==', orderId).limit(5).get();
  const grantDoc = snap.docs.find((d) => !d.data().aliasOf && !d.data().reason);
  if (!grantDoc) return { status: 'no_grant' };
  const grant = grantDoc.data();
  const uid = grant.uid;
  if (!(await accountExists(uid))) return { status: 'deleted_user', uid };
  let clawed = 0;
  let duplicate = false;
  await db.runTransaction(async (tx) => {
    const g = await tx.get(grantDoc.ref);
    if (g.data().clawedBackAt) { duplicate = true; return; }
    const uref = db.collection('users').doc(uid);
    const u = await tx.get(uref);
    const cur = u.exists && typeof u.data().credits === 'number' ? u.data().credits : 0;
    clawed = Math.min(cur, grant.amount || 0);
    const balanceAfter = cur - clawed;
    tx.set(uref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
    tx.set(grantDoc.ref, { clawedBackAt: new Date(), clawedBack: clawed }, { merge: true });
    creditService.recordTransactionInTx(tx, uid, {
      type: 'refund_clawback',
      amount: -clawed,
      balanceAfter,
      description: `Refunded ${grant.productId}`,
      meta: { productId: grant.productId, orderId, granted: grant.amount },
    });
  });
  if (duplicate) return { status: 'duplicate', uid };

  if (grant.kind === 'trial') {
    const all = await db.collection('credit_grants').where('uid', '==', uid).get();
    const otherPaid = all.docs.some((d) => {
      const x = d.data();
      return d.id !== grantDoc.id && !x.aliasOf && !x.reason && !x.clawedBackAt && x.kind !== 'trial';
    });
    if (!otherPaid) await entitlement.write(uid, { everPaid: false, active: false, isTrial: false });
  }
  if (purchaseToken && PLAN_CREDITS[grant.productId]) {
    // Refresh access from Play (a refunded subscription is usually revoked).
    await syncSubscription({ purchaseToken, productId: grant.productId }).catch(() => {});
  }
  console.log(`[credits] refund clawback -${clawed} uid=${uid} order=${orderId} kind=${grant.kind}`);
  return { status: 'clawed_back', uid, amount: clawed };
}

module.exports = { syncSubscription, handleVoided, isTrialPeriod, periodState, accountExists, TRIAL_REMINDERS };
