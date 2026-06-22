const { getDb } = require('./firestoreAdmin');
const instagramService = require('../services/instagram_service');

/**
 * Load REAL creator context for a user from their connected Instagram account.
 * Returns null when the user isn't connected, the token is expired, or anything
 * fails — callers MUST treat null as "no real data, use generic AI output".
 * Never throws.
 */
async function loadCreatorContext(uid) {
  if (!uid) return null;
  try {
    const db = getDb();
    if (!db) return null;
    const snap = await db.collection('users').doc(String(uid)).get();
    const user = snap.data() || {};
    const instagram = user.instagram || {};
    const token = String(instagram.access_token || '').trim();
    if (!token) return null;
    const expiresAt =
      instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
        ? instagram.token_expires_at.toDate()
        : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) return null;
    return await instagramService.buildCreatorContext(token);
  } catch (e) {
    console.warn('[creatorContext] load failed:', e.message);
    return null;
  }
}

/**
 * Render a creator context into a prompt block the model can use to personalize
 * output. Returns '' when there is no real data (so prompts stay clean).
 */
function formatForPrompt(ctx) {
  if (!ctx) return '';
  const lines = ['REAL ACCOUNT DATA (personalize to this creator — do NOT invent stats):'];
  if (ctx.followers) lines.push(`- Followers: ${ctx.followers}`);
  if (ctx.bestFormat) lines.push(`- Best-performing format for them: ${ctx.bestFormat}`);
  if (Array.isArray(ctx.bestHoursIST) && ctx.bestHoursIST.length) {
    lines.push(`- Audience most active (IST): ${ctx.bestHoursIST.map((h) => `${h}:00`).join(', ')}`);
  }
  if (Array.isArray(ctx.topHashtags) && ctx.topHashtags.length) {
    lines.push(`- Hashtags that worked in their top posts: ${ctx.topHashtags.join(' ')}`);
  }
  if (Array.isArray(ctx.topThemes) && ctx.topThemes.length) {
    lines.push(`- Themes from their best posts: ${ctx.topThemes.map((t) => `"${t}"`).join('; ')}`);
  }
  lines.push('Match what already works for THIS creator.');
  return lines.join('\n');
}

module.exports = { loadCreatorContext, formatForPrompt };
