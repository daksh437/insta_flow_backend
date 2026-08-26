/**
 * Daily Viral Drop generator — Gemini only. Reuses existing geminiClient.
 * Fetches trends from Google Trends RSS, builds prompt, calls Gemini, stores result by date.
 * No modification to existing AI routes or Gemini client.
 *
 * GUARD CONTEXT: This module is invoked only by server cron (node-cron), not by user HTTP requests.
 * Direct runGemini usage here is intentional — no user uid, no daily limit; server-side only.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runGemini } = require('../utils/geminiClient');
const { getDb } = require('../utils/firestoreAdmin');
const { buildCreatorContext } = require('./instagram_service');

// India trends — the app's audience is India-heavy, so US trends were off.
const TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=IN';
const FALLBACK_TRENDS = [
  'day in my life', 'get ready with me', 'morning routine', 'tips and tricks',
  'before and after', 'trending sound', 'challenge', 'relatable', 'storytime', 'tutorial',
];

const DATA_DIR = path.join(process.cwd(), 'data', 'daily_drops');
const inMemoryStore = new Map();
const DAILY_DROP_LOCK_TTL_MS = 3 * 60 * 1000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Firestore-backed distributed lock so concurrent callers (the midnight cron
 * plus any on-demand /daily-drop/today self-heal, possibly on different
 * Render instances) don't all pay for duplicate Gemini calls for the same
 * day. The in-memory/file store below is per-instance and doesn't survive
 * restarts, so it can't coordinate this by itself.
 */
async function claimDailyDropGeneration(key, db) {
  const ref = db.collection('daily_drop_locks').doc(key);
  const nowMs = Date.now();
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const lockedUntilMs = Number(snap.data()?.lockedUntilMs || 0);
      if (lockedUntilMs > nowMs) return false; // another instance is already generating
      tx.set(ref, { lockedAtMs: nowMs, lockedUntilMs: nowMs + DAILY_DROP_LOCK_TTL_MS }, { merge: true });
      return true;
    });
  } catch (e) {
    console.warn('[DailyDrop] claim failed, proceeding without lock:', e.message);
    return true;
  }
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (e) {
    console.warn('[DailyDrop] Could not create data dir:', e.message);
  }
}

function dateKey(date = new Date()) {
  // UTC to match the Flutter client (DailyDropService._dateKeyUtc), so the app
  // reads the exact daily_drops/{key} doc this generator writes.
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function storePath(key) {
  return path.join(DATA_DIR, `${key}.json`);
}

function loadFromFile(key) {
  try {
    const p = storePath(key);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('[DailyDrop] loadFromFile:', e.message);
  }
  return null;
}

function saveToFile(key, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(storePath(key), JSON.stringify(data, null, 0), 'utf8');
  } catch (e) {
    console.warn('[DailyDrop] saveToFile:', e.message);
  }
}

function getStored(key) {
  const mem = inMemoryStore.get(key);
  if (mem) return mem;
  const file = loadFromFile(key);
  if (file) {
    inMemoryStore.set(key, file);
    return file;
  }
  return null;
}

function setStored(key, data) {
  inMemoryStore.set(key, data);
  saveToFile(key, data);
}

/** Fetch trend keywords from Google Trends RSS; fallback to static list. */
async function fetchTrendKeywords() {
  try {
    const res = await axios.get(TRENDS_RSS_URL, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InstaFlow/1.0)' },
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data) return FALLBACK_TRENDS;
    const xml = typeof res.data === 'string' ? res.data : String(res.data);
    const titles = [];
    const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const t = m[1].replace(/<[^>]+>/g, '').trim();
      if (t.length > 0 && t.length < 80) titles.push(t);
    }
    if (titles.length > 0) return titles.slice(0, 15);
  } catch (err) {
    console.warn('[DailyDrop] fetchTrendKeywords failed:', err.message);
  }
  return FALLBACK_TRENDS;
}

/** Build daily drop prompt (exact template). */
function buildDailyDropPrompt(trendList) {
  const list = (trendList && trendList.length) ? trendList : FALLBACK_TRENDS;
  const trendListStr = list.slice(0, 15).join(', ');
  return `You are a viral Instagram reel strategist.

Using today's trend keywords:
${trendListStr}

Generate ONE daily viral reel execution plan.

Return STRICT JSON:
trend_theme
virality_score
reel_concept
steps (5)
hooks (5)
caption
hashtags (10)
best_post_time
coach_summary

Avoid repeating yesterday structure.`;
}

/**
 * Personalized prompt: blend today's trend with THIS creator's proven themes,
 * hashtags, best format and audience-active hours (from buildCreatorContext).
 */
function buildPersonalizedPrompt(trendList, ctx) {
  const list = (trendList && trendList.length) ? trendList : FALLBACK_TRENDS;
  const trendListStr = list.slice(0, 10).join(', ');
  const themes = (ctx.topThemes || []).slice(0, 4).map((t) => `- ${t}`).join('\n')
    || '- (not enough posts yet — infer from niche)';
  const tags = (ctx.topHashtags || []).slice(0, 10).join(' ') || '(none yet)';
  const hoursStr = (ctx.bestHoursIST || []).length
    ? ctx.bestHoursIST.map((h) => `${h}:00`).join(', ') + ' IST'
    : 'evening (7-9 PM IST)';
  return `You are a viral Instagram reel strategist creating a plan for ONE specific creator.

Creator profile:
- Username: @${ctx.username || 'creator'}
- Followers: ${ctx.followers || 0}
- Best-performing format: ${ctx.bestFormat || 'REELS'}
- Audience most active around: ${hoursStr}
- Hashtags that work for them: ${tags}
- Their best recent content themes:
${themes}

Today's trending keywords (India): ${trendListStr}

Blend the creator's proven style with a fresh trend. Make it feel MADE FOR THEM, not generic.

Return STRICT JSON:
trend_theme
virality_score
reel_concept
steps (5)
hooks (5)
caption
hashtags (10)  // mix their proven hashtags with trend hashtags
best_post_time  // use their audience-active hours above
coach_summary  // reference why this fits THEIR account`;
}

/** Fallback drop when Gemini fails after retry. */
function getFallbackDrop(trendList) {
  const trend = (trendList && trendList[0]) || FALLBACK_TRENDS[0];
  return {
    trend_theme: `Trending: ${trend} for creators`,
    virality_score: 72,
    reel_concept: `A scroll-stopping reel that uses "${trend}" with a clear hook, 3 quick tips, and a strong CTA.`,
    steps: [
      `Hook (0–3s): Open with a bold question about ${trend}`,
      'Problem (3–8s): One line on why most people get it wrong',
      'Tip 1 (8–14s): First actionable step',
      'Tip 2 (14–20s): Second step with a quick demo',
      'CTA (20–30s): Save, follow, or comment below',
    ],
    hooks: [
      `Nobody talks about this ${trend} trick…`,
      `Stop scrolling if you do ${trend} content.`,
      `This ${trend} tip changed everything.`,
      `POV: You finally get ${trend}.`,
      `I wish I knew this ${trend} hack sooner.`,
    ],
    caption: `Drop a 🔥 if you're trying this. Comment your go-to ${trend} tip below.`,
    hashtags: ['#' + trend.replace(/\s+/g, ''), '#reels', '#viral', '#contentcreator', '#tips', '#fyp', '#trending', '#explore', '#instagram', '#creator'],
    best_post_time: '7–9 AM or 7–9 PM in your timezone',
    coach_summary: `Today's trend: ${trend}. Best time to post: 7–9 AM or 7–9 PM. Use the hooks to stop the scroll.`,
  };
}

/** Parse Gemini text response into JSON; return null on failure. */
function parseDropJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end));
      } catch (e2) {
        return null;
      }
    }
  }
  return null;
}

/** Normalize and validate drop object for storage. */
function toStoredDoc(json) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (v != null ? String(v) : '');
  const num = (v) => (typeof v === 'number' ? v : parseInt(v, 10) || 0);
  return {
    trend_theme: str(json.trend_theme),
    virality_score: Math.min(100, Math.max(0, num(json.virality_score))),
    concept: str(json.reel_concept || json.concept),
    steps: arr(json.steps).slice(0, 5).map(String),
    hooks: arr(json.hooks).slice(0, 5).map(String),
    caption: str(json.caption),
    hashtags: arr(json.hashtags).slice(0, 10).map((h) => (String(h).startsWith('#') ? h : '#' + h)),
    best_time: str(json.best_post_time || json.best_time),
    coach_summary: str(json.coach_summary),
    created_at: new Date().toISOString(),
  };
}

/**
 * Generate daily drop: fetch trends, call Gemini (retry once), parse JSON, fallback on failure, store by date.
 * Reuses existing runGemini from geminiClient only.
 */
async function generateDailyDrop() {
  const key = dateKey();

  const db = getDb();
  if (db) {
    try {
      const existing = await db.collection('daily_drops').doc(key).get();
      if (existing.exists) {
        const doc = existing.data();
        setStored(key, doc);
        return doc;
      }
    } catch (e) {
      console.warn('[DailyDrop] Firestore existence check failed:', e.message);
    }

    const claimed = await claimDailyDropGeneration(key, db);
    if (!claimed) {
      // Someone else (another instance, or an overlapping cron/on-demand
      // call) is already generating this — wait for their result instead of
      // duplicating the Gemini calls.
      for (let i = 0; i < 6; i++) {
        await wait(2000);
        const stored = getStored(key);
        if (stored) return stored;
        try {
          const snap = await db.collection('daily_drops').doc(key).get();
          if (snap.exists) return snap.data();
        } catch (_) {}
      }
      // Gave up waiting — generate anyway rather than fail the request.
    }
  }

  const trends = await fetchTrendKeywords();
  const prompt = buildDailyDropPrompt(trends);
  const systemPrompt = 'Return only valid JSON. No markdown, no code fences, no extra text.';

  let json = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await runGemini(prompt, {
        systemPrompt,
        userPrompt: prompt,
        temperature: 0.7,
        maxTokens: 2048,
        thinkingLevel: 'low',
        label: 'daily-drop',
      });
      json = parseDropJson(raw);
      if (json) break;
    } catch (err) {
      console.warn(`[DailyDrop] Gemini attempt ${attempt} failed:`, err.message);
    }
  }

  if (!json) {
    console.warn('[DailyDrop] Using fallback template');
    json = getFallbackDrop(trends);
  }

  const doc = toStoredDoc(json);
  setStored(key, doc);
  await writeDropToFirestore(key, doc);
  console.log('[DailyDrop] Generated and stored:', key);
  return doc;
}

/**
 * Mirror the day's drop into Firestore (daily_drops/{key}) so the Flutter app —
 * which reads Firestore directly — can show it, and so it survives Render's
 * ephemeral filesystem across restarts/redeploys. Best-effort: never throws.
 */
async function writeDropToFirestore(key, doc) {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[DailyDrop] Firestore unavailable, skipped mirror for', key);
      return;
    }
    await db.collection('daily_drops').doc(key).set({ ...doc, date: key }, { merge: true });
    console.log('[DailyDrop] Mirrored to Firestore:', key);
  } catch (err) {
    console.error('[DailyDrop] Firestore mirror failed:', err.message);
  }
}

/**
 * Get today's drop from store (no AI call). Returns null if not yet generated.
 */
function getTodayDrop() {
  const key = dateKey();
  return getStored(key);
}

/**
 * Personalized daily drop for a connected creator. Reads their Instagram context
 * (proven themes, hashtags, best format & active hours) and blends it with
 * today's India trend. Cached per user per UTC day at
 * users/{uid}/personalized_drops/{dateKey}. Returns null if the user isn't
 * connected or generation fails — the caller then falls back to the global drop.
 */
async function generatePersonalizedDrop(uid) {
  const db = getDb();
  if (!db || !uid) return null;
  const key = dateKey();
  const cacheRef = db.collection('users').doc(uid).collection('personalized_drops').doc(key);

  try {
    const cached = await cacheRef.get();
    if (cached.exists) return cached.data();
  } catch (_) {}

  let token = null;
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    const data = userSnap.data() || {};
    token = String((data.instagram && data.instagram.access_token) || '').trim();
  } catch (_) {}
  if (!token) return null; // not connected → global drop

  let ctx;
  try {
    ctx = await buildCreatorContext(token);
  } catch (e) {
    console.warn('[DailyDrop] creator context failed for', uid, e.message);
    return null;
  }

  const trends = await fetchTrendKeywords();
  const prompt = buildPersonalizedPrompt(trends, ctx);
  const systemPrompt = 'Return only valid JSON. No markdown, no code fences, no extra text.';

  let json = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await runGemini(prompt, {
        systemPrompt,
        userPrompt: prompt,
        temperature: 0.7,
        maxTokens: 2048,
        thinkingLevel: 'low',
        label: 'daily-drop-personalized',
      });
      json = parseDropJson(raw);
      if (json) break;
    } catch (err) {
      console.warn(`[DailyDrop] personalized Gemini attempt ${attempt} failed:`, err.message);
    }
  }
  if (!json) return null; // fall back to global

  const doc = toStoredDoc(json);
  doc.personalized = true;
  doc.date = key;
  try {
    await cacheRef.set(doc, { merge: true });
  } catch (_) {}
  console.log('[DailyDrop] Personalized drop generated for', uid);
  return doc;
}

module.exports = {
  generateDailyDrop,
  // Shared with the Trending Hashtags tool so it works off the same live
  // Google Trends feed instead of asking the model to invent trends.
  fetchTrendKeywords,
  generatePersonalizedDrop,
  getTodayDrop,
  dateKey,
};
