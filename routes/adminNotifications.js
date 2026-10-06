const express = require('express');
const { requireAdmin } = require('../middleware/adminAuth');
const { previewCampaign, sendCampaign } = require('../controllers/adminNotificationsController');
const creditService = require('../services/creditService');

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

module.exports = router;
