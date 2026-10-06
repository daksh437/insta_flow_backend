const express = require('express');
const { requireAdmin } = require('../middleware/adminAuth');
const { previewCampaign, sendCampaign } = require('../controllers/adminNotificationsController');
const creditService = require('../services/creditService');
const { getDb } = require('../utils/firestoreAdmin');

const router = express.Router();

router.post('/notifications/preview', requireAdmin, previewCampaign);
router.post('/notifications/send', requireAdmin, sendCampaign);

const MAX_ADJUST = 100000;

/**
 * POST /admin/credits/adjust { targetUid, amount, reason, requestId }
 * The only way an admin changes a balance: written in one transaction with a
 * credit_transactions ledger entry (Firestore rules block direct writes).
 */
router.post('/credits/adjust', requireAdmin, async (req, res) => {
  const targetUid = String(req.body?.targetUid || '').trim();
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  const requestId = String(req.body?.requestId || '').trim();
  if (!targetUid || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_ADJUST || !reason || !/^[\w-]{8,64}$/.test(requestId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_INPUT',
      message: `targetUid, a non-zero whole amount (max ±${MAX_ADJUST}), a reason and a requestId are required`,
    });
  }
  try {
    const r = await creditService.adminAdjust(targetUid, amount, { adminUid: req.adminUid, reason, requestId });
    if (r.status === 'no_user') return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (r.status === 'insufficient') {
      return res.status(400).json({ success: false, error: 'INSUFFICIENT_BALANCE', message: `Balance is ${r.balanceAfter}`, balance: r.balanceAfter });
    }
    console.log(`[admin] credits ${amount > 0 ? '+' : ''}${amount} uid=${targetUid} by=${req.adminUid} (${reason}) ${r.status}`);
    return res.json({ success: true, status: r.status, balance: r.balanceAfter });
  } catch (e) {
    console.error('[admin] credits adjust failed:', e.message);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

const MAX_COMP_DAYS = 365;

/**
 * POST /admin/entitlement/grant { targetUid, days, reason, requestId }
 * Complimentary subscription access (e.g. the Play review account): active
 * for [days], no credits, no "everPaid". Idempotent per requestId, logged in
 * admin_entitlement_ops.
 */
router.post('/entitlement/grant', requireAdmin, async (req, res) => {
  const targetUid = String(req.body?.targetUid || '').trim();
  const days = Number(req.body?.days);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);
  const requestId = String(req.body?.requestId || '').trim();
  if (!targetUid || !Number.isInteger(days) || days < 1 || days > MAX_COMP_DAYS || !reason || !/^[\w-]{8,64}$/.test(requestId)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_INPUT',
      message: `targetUid, whole days (1-${MAX_COMP_DAYS}), a reason and a requestId are required`,
    });
  }
  try {
    const db = getDb();
    const userRef = db.collection('users').doc(targetUid);
    const opRef = db.collection('admin_entitlement_ops').doc(requestId);
    const result = await db.runTransaction(async (tx) => {
      const op = await tx.get(opRef);
      if (op.exists) return { status: 'duplicate', expiresAt: op.data().expiresAt };
      const user = await tx.get(userRef);
      if (!user.exists) return { status: 'no_user' };
      const expiresAt = new Date(Date.now() + days * 86400000);
      tx.set(userRef, {
        entitlement: {
          active: true,
          source: 'admin_comp',
          state: 'ADMIN_COMP',
          isTrial: false,
          autoRenewing: false,
          expiresAt,
          grantedBy: req.adminUid,
          updatedAt: new Date(),
        },
      }, { merge: true });
      tx.set(opRef, { targetUid, days, reason, adminUid: req.adminUid, expiresAt, at: new Date() });
      return { status: 'granted', expiresAt };
    });
    if (result.status === 'no_user') return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    console.log(`[admin] comp entitlement ${days}d uid=${targetUid} by=${req.adminUid} (${reason}) ${result.status}`);
    return res.json({ success: true, status: result.status, expiresAt: result.expiresAt });
  } catch (e) {
    console.error('[admin] entitlement grant failed:', e.message);
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
