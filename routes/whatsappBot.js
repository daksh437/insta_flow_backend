const express = require('express');

const router = express.Router();

/**
 * POST /whatsapp-bot/connect
 * Body: { accessToken?: string, code?: string }
 * Called from Flutter after Meta OAuth WebView callback.
 */
router.post('/whatsapp-bot/connect', (req, res) => {
  const { accessToken, code } = req.body || {};
  console.log('[WhatsApp Bot] connect', {
    hasAccessToken: !!accessToken,
    hasCode: !!code,
    uid: req.headers['x-user-uid'] || req.headers['authorization']?.slice(0, 20),
  });
  return res.json({
    success: true,
    message: 'WhatsApp connect registered (stub)',
  });
});

/**
 * POST /whatsapp-bot/send-message
 * Body: { chatId: string, text: string }
 */
router.post('/whatsapp-bot/send-message', (req, res) => {
  const { chatId, text } = req.body || {};
  console.log('[WhatsApp Bot] send-message', {
    chatId: chatId ?? '(missing)',
    textLen: text != null ? String(text).length : 0,
  });
  return res.json({
    success: true,
    messageId: `mock_${Date.now()}`,
  });
});

/**
 * GET /whatsapp-bot/chats
 * Returns placeholder list; replace with DB / Meta API later.
 */
router.get('/whatsapp-bot/chats', (_req, res) => {
  return res.json({
    success: true,
    chats: [
      {
        id: 'c1',
        name: 'Alex Johnson',
        lastMessage: 'Can you share pricing for the starter package?',
        unread: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
  });
});

module.exports = router;
