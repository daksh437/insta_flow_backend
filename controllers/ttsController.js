const axios = require('axios');
const crypto = require('crypto');
const creditService = require('../services/creditService');
const { CREDITS_ENABLED } = require('../middleware/aiAccess');

const DEFAULT_LANGUAGE = 'en-IN';

// Google charges Text-to-Speech per CHARACTER, so unlike the Gemini tools this
// one has no natural per-request ceiling — a single call with a long string can
// cost more than a whole AI generation. Neural2 is $16 per 1M characters
// (~Rs1.41 per 1000 chars at Rs88/$), Standard is $4 per 1M (~Rs0.35).
//
// Voice tier is switchable without a redeploy: Neural2 is the default so the
// shipped app sounds the same, but flipping TTS_VOICE_TIER=standard cuts the
// cost 4x if the credit price ever feels too steep to users.
const VOICE_TIER = (process.env.TTS_VOICE_TIER || 'neural2').toLowerCase() === 'standard'
  ? 'standard'
  : 'neural2';

const VOICES = {
  neural2: { 'en-IN': 'en-IN-Neural2-A', 'hi-IN': 'hi-IN-Neural2-A' },
  standard: { 'en-IN': 'en-IN-Standard-A', 'hi-IN': 'hi-IN-Standard-A' },
};

// Characters per credit, derived from the real rate so a credit buys roughly
// the same value here as on the Gemini tools (~Rs0.14 of API spend).
//   neural2: Rs0.001408/char -> ~100 chars per credit
//   standard: Rs0.000352/char -> ~400 chars per credit
const CHARS_PER_CREDIT = {
  neural2: Number(process.env.TTS_CHARS_PER_CREDIT_NEURAL2) || 100,
  standard: Number(process.env.TTS_CHARS_PER_CREDIT_STANDARD) || 400,
};

// Hard ceiling on one request. Without it a single call could synthesize an
// arbitrarily long string; this caps the worst case at a known number of
// credits (10 on neural2, 3 on standard) and makes abuse bounded.
const MAX_CHARS = Number(process.env.TTS_MAX_CHARS) || 1000;

// The credit spend is idempotent per (uid, text, day), so a replay is free for
// the user — but without this it would still be a fresh billed call to Google.
// Small in-memory LRU keyed by the same hash closes that gap: a replay costs
// neither credits nor API spend. Bounded so a long-running dyno can't grow
// unboundedly; a restart just repopulates it.
const AUDIO_CACHE_MAX = Number(process.env.TTS_CACHE_ENTRIES) || 100;
const audioCache = new Map();

function cacheGet(key) {
  if (!audioCache.has(key)) return null;
  const value = audioCache.get(key);
  audioCache.delete(key); // re-insert to mark as most recently used
  audioCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (audioCache.has(key)) audioCache.delete(key);
  audioCache.set(key, value);
  if (audioCache.size > AUDIO_CACHE_MAX) {
    audioCache.delete(audioCache.keys().next().value); // evict oldest
  }
}

function resolveVoice(languageCode) {
  const lang = (languageCode || DEFAULT_LANGUAGE).toLowerCase();
  const table = VOICES[VOICE_TIER];
  return lang.startsWith('hi') ? table['hi-IN'] : table['en-IN'];
}

/** Credits for a piece of text at the active voice tier. Always at least 1. */
function creditsForText(text) {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_CREDIT[VOICE_TIER]));
}

/** UTC date key, so the idempotency window is a server-side day. */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * POST /api/tts — synthesize speech for an AI result.
 *
 * This used to be completely unauthenticated: no token, no credits, no length
 * limit. Anyone on the internet could POST arbitrary text and bill the project's
 * Google Cloud account. It now requires a verified Firebase ID token (applied in
 * routes/tts.js) and charges credits by length.
 *
 * The spend is idempotent on (uid, text, language, UTC day), so replaying the
 * same clip during a session — or retrying after a dropped connection — is
 * charged once, matching the client's on-device audio cache.
 */
async function synthesizeTts(req, res) {
  const text = String(req.body?.text || '').trim();
  const languageCode = String(req.body?.languageCode || DEFAULT_LANGUAGE).trim();
  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_TTS_API_KEY || '';
  const uid = req.uid;

  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  if (text.length > MAX_CHARS) {
    return res.status(413).json({
      error: 'TEXT_TOO_LONG',
      message: `Text must be ${MAX_CHARS} characters or fewer`,
      maxChars: MAX_CHARS,
      length: text.length,
    });
  }

  if (!apiKey) {
    console.error('[TTS] Missing GOOGLE_TTS_API_KEY');
    return res.status(500).json({ error: 'TTS unavailable' });
  }

  // Charge before calling Google, atomically — an unpaid request must never
  // reach the billed API.
  const cost = creditsForText(text);
  const textHash = crypto.createHash('sha256')
    .update(`${text}|${languageCode}`)
    .digest('hex')
    .slice(0, 32);
  const idemKey = `tts:${todayKey()}:${textHash}`;

  // Follows the same master switch as the /ai/* routes — with credits off,
  // voice playback is free rather than being the one thing that still bills.
  let charged = true;
  try {
    if (CREDITS_ENABLED) charged = await creditService.spend(uid, cost, idemKey, 'Voice Playback');
  } catch (e) {
    console.error('[TTS] credit spend failed:', e.message);
    return res.status(500).json({ error: 'TTS unavailable' });
  }

  if (!charged) {
    const balance = await creditService.getBalance(uid);
    return res.status(403).json({
      success: false,
      error: 'INSUFFICIENT_CREDITS',
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits for voice playback',
      balance,
      cost,
    });
  }

  // Serve a replay from cache: the user already paid for this clip today, and
  // re-synthesizing identical text would just be a second bill from Google.
  const cached = cacheGet(textHash);
  if (cached) {
    console.log(`[TTS] cache hit uid=${uid} textLen=${text.length} lang=${languageCode}`);
    return res.json({ audioContent: cached, cost, cached: true });
  }

  const requestPayload = {
    input: { text },
    voice: {
      languageCode,
      name: resolveVoice(languageCode),
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0,
    },
  };

  try {
    console.log(`[TTS] request uid=${uid} textLen=${text.length} lang=${languageCode} tier=${VOICE_TIER} cost=${cost}`);
    const response = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      requestPayload,
      {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const audioContent = response.data?.audioContent;
    if (!audioContent || typeof audioContent !== 'string') {
      console.error('[TTS] success=false reason=missing_audioContent');
      return res.status(502).json({ error: 'TTS unavailable' });
    }

    cacheSet(textHash, audioContent);
    console.log(`[TTS] success uid=${uid} textLen=${text.length} lang=${languageCode} cost=${cost}`);
    return res.json({ audioContent, cost });
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    console.error('[TTS] failed', { status, detail });
    // Already charged for this (uid, text, day); the idempotency key makes the
    // user's retry free, so they are not billed twice for one clip.
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: 'TTS unavailable',
    });
  }
}

module.exports = {
  synthesizeTts,
  // exported for tests
  creditsForText,
  MAX_CHARS,
  VOICE_TIER,
};
