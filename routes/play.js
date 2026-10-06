/**
 * POST /play/rtdn — Google Play Real-time Developer Notifications, delivered
 * by a Pub/Sub push subscription (OIDC-authenticated, utils/pubsubAuth.js).
 *
 * Every notification is re-checked against the Play Developer API; the
 * message body itself is never trusted for state. Responses:
 *   200 handled / nothing to do (Pub/Sub stops retrying)
 *   401 bad or missing OIDC token
 *   503 Play API unavailable (Pub/Sub retries with backoff)
 */
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const { verifyPushRequest } = require('../utils/pubsubAuth');
const { PACKAGE_NAME } = require('../utils/playVerify');
const subscriptionSync = require('../services/subscriptionSync');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Play SubscriptionNotification.notificationType (for logs).
const SUB_TYPES = {
  1: 'RECOVERED', 2: 'RENEWED', 3: 'CANCELED', 4: 'PURCHASED', 5: 'ON_HOLD',
  6: 'IN_GRACE_PERIOD', 7: 'RESTARTED', 8: 'PRICE_CHANGE_CONFIRMED', 9: 'DEFERRED',
  10: 'PAUSED', 11: 'PAUSE_SCHEDULE_CHANGED', 12: 'REVOKED', 13: 'EXPIRED',
  19: 'PRICE_CHANGE_UPDATED', 20: 'PENDING_PURCHASE_CANCELED',
};

function decode(body) {
  const data = body && body.message && body.message.data;
  if (!data) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

router.post('/rtdn', async (req, res) => {
  const auth = await verifyPushRequest(req);
  if (!auth.ok) {
    console.warn('[rtdn] rejected push:', auth.reason);
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }
  const n = decode(req.body);
  if (!n) return res.status(200).json({ success: true, ignored: 'unreadable message' });
  if (n.packageName && n.packageName !== PACKAGE_NAME) {
    return res.status(200).json({ success: true, ignored: `package ${n.packageName}` });
  }
  if (n.testNotification) {
    console.log('[rtdn] ✅ test notification received');
    return res.status(200).json({ success: true, test: true });
  }

  try {
    if (n.subscriptionNotification) {
      const { notificationType, purchaseToken, subscriptionId } = n.subscriptionNotification;
      const type = SUB_TYPES[notificationType] || String(notificationType);
      const r = await subscriptionSync.syncSubscription({ purchaseToken, productId: subscriptionId });
      if (r.status === 'unavailable') {
        console.error(`[rtdn] ${type}: Play unavailable (${r.reason}) — Pub/Sub will retry`);
        return res.status(503).json({ success: false, error: 'PLAY_UNAVAILABLE' });
      }
      if (r.status === 'unowned') {
        // Purchased before the app reported it; /activate-premium will sync it.
        await getDb().collection('rtdn_unmatched').doc(sha(purchaseToken)).set({
          purchaseToken, subscriptionId, type, at: new Date(),
        }, { merge: true });
      }
      console.log(`[rtdn] ${type} ${subscriptionId} → ${r.status}${r.uid ? ` uid=${r.uid}` : ''}${r.granted ? ` +${r.amount}` : ''}`);
      return res.status(200).json({ success: true, status: r.status });
    }
    if (n.voidedPurchaseNotification) {
      const { purchaseToken, orderId } = n.voidedPurchaseNotification;
      const r = await subscriptionSync.handleVoided({ purchaseToken, orderId });
      console.log(`[rtdn] VOIDED order=${orderId} → ${r.status}`);
      return res.status(200).json({ success: true, status: r.status });
    }
    // One-time products (credit packs) are granted when the app reports them.
    return res.status(200).json({ success: true, ignored: 'notification type' });
  } catch (e) {
    console.error('[rtdn] handler error:', e.message);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
