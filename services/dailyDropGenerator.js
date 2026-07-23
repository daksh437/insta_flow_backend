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

const TRENDS_RSS_URL = 'https://trends.google.com/trending/rss?geo=US';
const FALLBACK_TRENDS = [
  'day in my life', 'get ready with me', 'morning routine', 'tips and tricks',
  'before and after', 'trending sound', 'challenge', 'relatable', 'storytime', 'tutorial',
];

const DATA_DIR = path.join(process.cwd(), 'data', 'daily_drops');
const inMemoryStore = new Map();

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

module.exports = {
  generateDailyDrop,
  getTodayDrop,
  dateKey,
};
