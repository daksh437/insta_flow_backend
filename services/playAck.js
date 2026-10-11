/**
 * Server-side acknowledgement of Play subscriptions, as a safety net.
 *
 * Google refunds and revokes a purchase that is not acknowledged within 3
 * days. The app acknowledges right after activation, but a payment that was
 * PENDING (UPI, cash) can complete while the app is closed: the RTDN then
 * grants access, and if the user does not open the app for 3 days the money
 * is refunded. syncSubscription records every paid-but-unacknowledged token
 * here; the 10-minute cron acknowledges the ones the app still hasn't after
 * GRACE_MS (so it never races the app's own acknowledgement).
 */
const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const { getPublisherApi, PACKAGE_NAME } = require('../utils/playVerify');

const COLLECTION = 'play_ack_pending';
const GRACE_MS = 15 * 60 * 1000;
const ACK_PENDING = 'ACKNOWLEDGEMENT_STATE_PENDING';
const ACKABLE_STATES = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);

const docId = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Called by syncSubscription for a paid subscription; no-op once acknowledged. */
async function noteIfUnacknowledged({ data, purchaseToken, productId, uid, now = new Date() }) {
  const ref = getDb().collection(COLLECTION).doc(docId(purchaseToken));
  if (!data || data.acknowledgementState !== ACK_PENDING) {
    await ref.delete().catch(() => {});
    return false;
  }
  const existing = await ref.get();
  if (existing.exists) return true;
  await ref.set({ purchaseToken, productId, uid, firstSeenAt: now });
  return true;
}

/**
 * Acknowledge every recorded subscription the app has not acknowledged for
 * GRACE_MS. @returns {{acknowledged, alreadyDone, dropped, errors}}
 */
async function sweepUnacknowledged(now = new Date()) {
  const db = getDb();
  const out = { acknowledged: 0, alreadyDone: 0, dropped: 0, errors: 0 };
  const due = await db.collection(COLLECTION)
    .where('firstSeenAt', '<=', new Date(now.getTime() - GRACE_MS)).limit(100).get();
  if (due.empty) return out;
  const api = getPublisherApi();
  for (const doc of due.docs) {
    const { purchaseToken, productId, uid } = doc.data();
    try {
      const { data } = await api.purchases.subscriptionsv2.get({ packageName: PACKAGE_NAME, token: purchaseToken });
      if (data.acknowledgementState !== ACK_PENDING) {
        out.alreadyDone++;
      } else if (!ACKABLE_STATES.has(data.subscriptionState)) {
        out.dropped++; // not paid any more (expired, revoked, pending again): nothing to keep
      } else {
        await api.purchases.subscriptions.acknowledge({
          packageName: PACKAGE_NAME,
          subscriptionId: productId,
          token: purchaseToken,
          requestBody: { developerPayload: `server-ack uid=${uid}` },
        });
        out.acknowledged++;
        console.log(`[playAck] acknowledged ${productId} for uid=${uid} (the app had not)`);
      }
      await doc.ref.delete();
    } catch (e) {
      out.errors++;
      console.warn(`[playAck] ${productId} uid=${uid}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { noteIfUnacknowledged, sweepUnacknowledged, COLLECTION, GRACE_MS };
