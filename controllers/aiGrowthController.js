/**
 * Instagram growth AI: full-assist, viral captions, post insights.
 * Uses Gemini Vision + sharp for image enhancement.
 */
const axios = require('axios');
const sharp = require('sharp');
const { runGemini, runGeminiWithImage } = require('../utils/geminiClient');
const { processImageForGemini } = require('../utils/imageProcessor');
const { recordAiUsage } = require('../middleware/aiAccess');

const DOWNLOAD_TIMEOUT_MS = 25000;
const GEMINI_TIMEOUT_MS = 90000;
const MAX_BASE64_CHARS = 12 * 1024 * 1024; // ~9MB binary

function parseJsonFromGeminiText(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      cleaned = cleaned.substring(first, last + 1);
    }
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[aiGrowth] JSON parse failed:', e.message);
    return null;
  }
}

async function loadImageBuffer(body) {
  const { imageUrl, imageBase64, imageMimeType = 'image/jpeg' } = body || {};
  if (imageBase64 && typeof imageBase64 === 'string') {
    if (imageBase64.length > MAX_BASE64_CHARS) {
      throw new Error('IMAGE_TOO_LARGE');
    }
    const clean = imageBase64.includes('base64,') ? imageBase64.split('base64,').pop() : imageBase64;
    return { buffer: Buffer.from(clean, 'base64'), mimeType: imageMimeType };
  }
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: 15 * 1024 * 1024,
      maxBodyLength: 15 * 1024 * 1024,
    });
    const mime = res.headers['content-type'] && res.headers['content-type'].split(';')[0].trim();
    return { buffer: Buffer.from(res.data), mimeType: mime || 'image/jpeg' };
  }
  throw new Error('MISSING_IMAGE: Provide imageUrl or imageBase64');
}

async function enhanceWithSharp(buffer) {
  try {
    const out = await sharp(buffer)
      .rotate()
      .modulate({ brightness: 1.06, saturation: 1.1 })
      .sharpen({ sigma: 0.85 })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString('base64')}`;
  } catch (e) {
    console.error('[aiGrowth] sharp enhance failed:', e.message);
    return null;
  }
}

const FULL_ASSIST_PROMPT = (topicHint) => `You are an elite Instagram growth strategist. Analyze the image.

Return ONLY valid JSON (no markdown) with exactly these keys:
- "caption": string, viral Instagram caption with emojis and a clear CTA, under 150 words, line breaks allowed
- "hashtags": array of exactly 20 strings, each starting with #, mix of high-reach broad tags + medium + niche-specific
- "engagementScore": integer from 0 to 100 predicting relative engagement potential
- "bestTime": string, one human-readable suggestion like "7:00 PM" (local time hint for the creator's audience)
- "tips": string, 2-4 sentences of concrete improvements (hook, visual, caption structure)

Topic or niche hint from user: ${topicHint || 'general lifestyle / creator content'}`;

const VIRAL_CAPTION_PROMPT = (topic) => `Write ONE viral Instagram caption for this topic or image.
Rules: engaging hook, emojis where natural, clear CTA, under 150 words, authentic voice.
Topic: ${topic || 'general engaging post'}`;

const POST_ANALYZE_PROMPT = (caption, tags) => `Analyze this Instagram post draft for growth.

Caption:
${caption}

Hashtags:
${tags}

Return ONLY valid JSON with keys:
- "engagementScore": integer 0-100
- "bestTime": string like "6:30 PM"
- "tips": string with 2-4 actionable sentences
- "suggestions": string array of 3-5 short bullet improvements`;

/**
 * POST /ai/full-assist
 * Body: { imageUrl?, imageBase64?, imageMimeType?, topic? }
 */
async function fullAssist(req, res) {
  const topic = (req.body && req.body.topic) || '';
  console.log('[aiGrowth] full-assist', { hasUrl: !!(req.body && req.body.imageUrl), hasB64: !!(req.body && req.body.imageBase64) });

  try {
    const { buffer, mimeType } = await loadImageBuffer(req.body || {});
    const enhancedImage = (await enhanceWithSharp(buffer)) || (req.body && req.body.imageUrl) || '';

    const b64 = buffer.toString('base64');
    const processed = await processImageForGemini(b64, mimeType);
    const prompt = FULL_ASSIST_PROMPT(topic);
    const raw = await runGeminiWithImage(prompt, processed.base64, processed.mimeType, {
      timeout: GEMINI_TIMEOUT_MS,
      maxTokens: 2048,
      temperature: 0.75,
    });

    let parsed = parseJsonFromGeminiText(raw);
    if (!parsed || typeof parsed !== 'object') {
      parsed = {
        caption: typeof raw === 'string' ? raw.slice(0, 2000) : '',
        hashtags: [],
        engagementScore: 70,
        bestTime: '7:00 PM',
        tips: 'Add a stronger hook in the first line and use a clear CTA.',
      };
    }

    let hashtags = parsed.hashtags;
    if (!Array.isArray(hashtags)) hashtags = [];
    hashtags = hashtags
      .map((h) => (typeof h === 'string' ? h.trim() : ''))
      .filter(Boolean)
      .map((h) => (h.startsWith('#') ? h : `#${h}`));
    const fallbacks = [
      '#instagram', '#instagood', '#photooftheday', '#love', '#beautiful', '#happy', '#reels',
      '#explorepage', '#trending', '#creator', '#content', '#growth', '#socialmedia', '#brand',
      '#community', '#lifestyle', '#inspiration', '#motivation', '#newpost', '#viral', '#fyp',
    ];
    let i = 0;
    while (hashtags.length < 20 && i < fallbacks.length * 2) {
      const t = fallbacks[i % fallbacks.length];
      if (!hashtags.includes(t)) hashtags.push(t);
      i++;
    }
    hashtags = hashtags.slice(0, 20);

    const engagementScore = Math.min(100, Math.max(0, parseInt(parsed.engagementScore, 10) || 72));
    const bestTime = typeof parsed.bestTime === 'string' ? parsed.bestTime : '7:00 PM';
    const tips = typeof parsed.tips === 'string' ? parsed.tips : String(parsed.tips || '');
    const caption = typeof parsed.caption === 'string' ? parsed.caption : '';

    if (req.uid) {
      recordAiUsage(req.uid, null, req.idempotencyKey, {
        endpoint: req._aiEndpoint || '/ai/full-assist',
      });
    }

    return res.json({
      success: true,
      enhancedImage,
      caption,
      hashtags,
      engagementScore,
      bestTime,
      tips,
    });
  } catch (error) {
    console.error('[aiGrowth] full-assist error:', error.message);
    const status = error.message === 'IMAGE_TOO_LARGE' ? 413 : error.message.startsWith('MISSING_IMAGE') ? 400 : 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'FULL_ASSIST_FAILED',
      details: error.message,
    });
  }
}

/**
 * POST /ai/caption  (viral caption — distinct from /ai/captions batch)
 * Body: { topic?, imageUrl?, imageBase64?, imageMimeType? }
 */
async function viralCaption(req, res) {
  const topic = (req.body && req.body.topic) || '';
  const hasImage = !!(req.body && (req.body.imageUrl || req.body.imageBase64));

  try {
    if (hasImage) {
      const { buffer, mimeType } = await loadImageBuffer(req.body || {});
      const b64 = buffer.toString('base64');
      const processed = await processImageForGemini(b64, mimeType);
      const raw = await runGeminiWithImage(VIRAL_CAPTION_PROMPT(topic), processed.base64, processed.mimeType, {
        timeout: GEMINI_TIMEOUT_MS,
        maxTokens: 1024,
        temperature: 0.85,
      });
      if (req.uid) {
        recordAiUsage(req.uid, null, req.idempotencyKey, { endpoint: req._aiEndpoint || '/ai/caption' });
      }
      return res.json({ success: true, caption: String(raw).trim() });
    }

    const raw = await runGemini(VIRAL_CAPTION_PROMPT(topic), { timeout: GEMINI_TIMEOUT_MS, maxTokens: 1024 });
    if (req.uid) {
      recordAiUsage(req.uid, null, req.idempotencyKey, { endpoint: req._aiEndpoint || '/ai/caption' });
    }
    return res.json({ success: true, caption: String(raw).trim() });
  } catch (error) {
    console.error('[aiGrowth] caption error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'CAPTION_FAILED',
      details: error.message,
    });
  }
}

/**
 * POST /ai/analyze-post  (post draft analyzer — caption + hashtags)
 * Body: { caption, hashtags: string | string[] }
 */
async function postAnalyze(req, res) {
  const { caption = '', hashtags } = req.body || {};
  const tagStr = Array.isArray(hashtags) ? hashtags.join(' ') : String(hashtags || '');

  try {
    const raw = await runGemini(POST_ANALYZE_PROMPT(String(caption), tagStr), {
      timeout: 60000,
      maxTokens: 1024,
      temperature: 0.6,
    });
    let parsed = parseJsonFromGeminiText(raw);
    if (!parsed || typeof parsed !== 'object') {
      parsed = {
        engagementScore: 65,
        bestTime: '7:00 PM',
        tips: 'Tighten your opening line and add one niche hashtag.',
        suggestions: ['Add a question in the first sentence', 'Use 3–5 strong niche tags'],
      };
    }

    const engagementScore = Math.min(100, Math.max(0, parseInt(parsed.engagementScore, 10) || 68));
    if (req.uid) {
      recordAiUsage(req.uid, null, req.idempotencyKey, {
        endpoint: req._aiEndpoint || '/ai/analyze-post',
      });
    }

    return res.json({
      success: true,
      engagementScore,
      bestTime: typeof parsed.bestTime === 'string' ? parsed.bestTime : '7:00 PM',
      tips: typeof parsed.tips === 'string' ? parsed.tips : '',
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    });
  } catch (error) {
    console.error('[aiGrowth] analyze-post error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'ANALYZE_FAILED',
      details: error.message,
    });
  }
}

module.exports = {
  fullAssist,
  viralCaption,
  postAnalyze,
};
