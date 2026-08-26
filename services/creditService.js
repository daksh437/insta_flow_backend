// Credit ledger — server-authoritative. All mutations are atomic (transactions)
// so retries/races never double-grant or double-charge.
const { getDb } = require('../utils/firestoreAdmin');
const { FREE_GRANTS, PLAN_CREDITS, PACK_CREDITS, costForEndpoint } = require('../config/credits');

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Write one ledger entry inside an already-open Firestore transaction, so
 * the entry is atomic with whatever balance change it's describing — the
 * user's Credit History screen (bank-statement style) reads this
 * subcollection. Call this from inside every credit-mutating tx, right
 * alongside the balance write.
 */
function recordTransactionInTx(tx, uid, { type, amount, balanceAfter, description, meta }) {
  const db = getDb();
  const txnRef = db.collection('users').doc(uid).collection('credit_transactions').doc();
  tx.set(txnRef, {
    type,
    amount,
    balanceAfter,
    description: description || type,
    meta: meta || null,
    at: new Date(),
  });
}

// Map an AI endpoint path to a credit-cost key.
function endpointToCostKey(endpoint) {
  const p = String(endpoint || '').toLowerCase();
  if (p.includes('daily-drop')) return 'daily_drop';
  // Specific routes first — 'analyze-post' would otherwise be caught by the
  // 'analyze' check below and priced as a full niche analysis.
  if (p.includes('analyze-post')) return 'post_analyze';
  if (p.includes('full-assist')) return 'full_assist';
  if (p.includes('growth-coach')) return 'growth_coach';
  if (p.includes('hook')) return 'hooks';
  if (p.includes('caption-from-media')) return 'caption_from_media';
  if (p.includes('image-captions')) return 'caption_from_media';
  if (p.includes('/image')) return 'image';
  if (p.includes('caption')) return 'caption';
  if (p.includes('hashtag')) return 'hashtag';
  if (p.includes('bio')) return 'bio';
  if (p.includes('carousel')) return 'carousel';
  if (p.includes('calendar')) return 'content_planner';
  if (p.includes('reels') || p.includes('reel')) return 'reels_script';
  if (p.includes('strategy')) return 'strategy';
  if (p.includes('analyze') || p.includes('niche')) return 'niche_analysis';
  if (p.includes('comment')) return 'comment_reply';
  if (p.includes('rewrite')) return 'rewrite';
  if (p.includes('trend')) return 'trending';
  if (p.includes('content-engine')) return 'content_engine';
  if (p.includes('ideas') || p.includes('post')) return 'post_ideas';
  return null; // → DEFAULT_COST
}

function costForPath(endpoint) {
  return costForEndpoint(endpointToCostKey(endpoint));
}

// Human-readable tool name for a cost key, shown as the Credit History line
// for a spend (e.g. "AI Caption Generator" instead of the raw key "caption").
const COST_KEY_LABELS = {
  caption: 'AI Caption Generator',
  hashtag: 'Hashtag Generator',
  bio: 'Bio Maker',
  post_ideas: 'Post Ideas',
  carousel: 'Carousel Writer',
  content_planner: 'Content Calendar',
  reels_script: 'Reel Script Writer',
  strategy: 'AI Strategy',
  niche_analysis: 'Niche Analysis',
  comment_reply: 'Comment Reply',
  rewrite: 'Rewrite Tool',
  trending: 'Trending Hashtags',
  content_engine: 'AI Content Engine',
  caption_from_media: 'Caption from Photo',
  background_remove: 'Background Remove',
  image: 'Studio Image',
  thumbnail: 'Thumbnail Maker',
  logo: 'Logo Maker',
  image_edit: 'Image Edit',
  daily_drop: 'Daily Viral Drop',
  growth_coach: 'Growth Coach',
};

function labelForEndpoint(endpoint) {
  const key = endpointToCostKey(endpoint);
  return (key && COST_KEY_LABELS[key]) || 'AI generation';
}

async function getBalance(uid) {
  const db = getDb();
  if (!db || !uid) return 0;
  const snap = await db.collection('users').doc(uid).get();
  const c = snap.exists ? snap.data().credits : 0;
  return typeof c === 'number' && c > 0 ? Math.floor(c) : 0;
}

// One-time signup bonus.
async function ensureSignupBonus(uid) {
  const db = getDb();
  if (!db || !uid) return;
  const ref = db.collection('users').doc(uid);
  try {
    const granted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (d.creditsSignupBonusGranted === true) return false;
      const current = typeof d.credits === 'number' ? d.credits : 0;
      const balanceAfter = current + FREE_GRANTS.NEW_USER_BONUS;
      tx.set(ref, {
        credits: balanceAfter,
        creditsSignupBonusGranted: true,
        creditsUpdatedAt: new Date(),
      }, { merge: true });
      recordTransactionInTx(tx, uid, {
        type: 'signup_bonus',
        amount: FREE_GRANTS.NEW_USER_BONUS,
        balanceAfter,
        description: 'Welcome gift',
      });
      return true;
    });
    console.log(`[credits] ensureSignupBonus uid=${uid} granted=${granted}`);
    return granted;
  } catch (e) {
    console.warn('[credits] signup bonus failed:', uid, e.message);
    return false;
  }
}

// Daily login grant (once per UTC day).
async function grantDailyLoginIfDue(uid) {
  const db = getDb();
  if (!db || !uid) return;
  const ref = db.collection('users').doc(uid);
  const today = todayUtc();
  try {
    const granted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (d.creditsDailyDate === today) return false;
      const current = typeof d.credits === 'number' ? d.credits : 0;
      const balanceAfter = current + FREE_GRANTS.DAILY_LOGIN;
      tx.set(ref, {
        credits: balanceAfter,
        creditsDailyDate: today,
        creditsUpdatedAt: new Date(),
      }, { merge: true });
      recordTransactionInTx(tx, uid, {
        type: 'daily_login',
        amount: FREE_GRANTS.DAILY_LOGIN,
        balanceAfter,
        description: 'Daily free credits',
      });
      return true;
    });
    console.log(`[credits] grantDailyLoginIfDue uid=${uid} granted=${granted}`);
    return granted;
  } catch (e) {
    console.warn('[credits] daily grant failed:', uid, e.message);
    return false;
  }
}

// One-time claim, generic: grants `amount` credits the first time, marking
// `flagField` so a repeat claim is a no-op. Used for the Instagram-follow /
// YouTube-subscribe Gift-screen rewards — honor system (no real follow/
// subscribe verification), same trust model as the signup bonus.
async function claimOnceFlag(uid, flagField, amount, type, description) {
  const db = getDb();
  if (!db || !uid) return false;
  const ref = db.collection('users').doc(uid);
  try {
    const granted = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (d[flagField] === true) return false;
      const current = typeof d.credits === 'number' ? d.credits : 0;
      const balanceAfter = current + amount;
      tx.set(ref, {
        credits: balanceAfter,
        [flagField]: true,
        creditsUpdatedAt: new Date(),
      }, { merge: true });
      recordTransactionInTx(tx, uid, { type, amount, balanceAfter, description });
      return true;
    });
    console.log(`[credits] claimOnceFlag uid=${uid} flag=${flagField} granted=${granted}`);
    return granted;
  } catch (e) {
    console.warn(`[credits] claimOnceFlag(${flagField}) failed:`, uid, e.message);
    return false;
  }
}

function claimInstagramFollow(uid) {
  return claimOnceFlag(uid, 'instagramFollowClaimed', FREE_GRANTS.INSTAGRAM_FOLLOW, 'instagram_follow', 'Followed on Instagram');
}

function claimYoutubeSubscribe(uid) {
  return claimOnceFlag(uid, 'youtubeSubscribeClaimed', FREE_GRANTS.YOUTUBE_SUBSCRIBE, 'youtube_subscribe', 'Subscribed on YouTube');
}

// Grant credits (plan/pack purchase, referral, admin).
async function grant(uid, amount, reason = 'grant') {
  const db = getDb();
  if (!db || !uid || !(amount > 0)) return;
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists && typeof snap.data().credits === 'number' ? snap.data().credits : 0;
    const balanceAfter = current + Math.floor(amount);
    tx.set(ref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
    recordTransactionInTx(tx, uid, { type: reason, amount: Math.floor(amount), balanceAfter, description: reason });
  });
  console.log(`[credits] +${amount} to ${uid} (${reason})`);
}

// Spend credits atomically, idempotent by key. Returns true if charged (or
// already charged for this key), false if insufficient balance.
// `description` is the human-readable line shown in Credit History (e.g. the
// AI tool name) — pass it from the caller, which knows the endpoint/tool.
async function spend(uid, cost, idemKey, description) {
  const db = getDb();
  if (!db || !uid) return false;
  if (!(cost > 0)) return true;
  const ref = db.collection('users').doc(uid);
  const keyRef = idemKey
    ? db.collection('users').doc(uid).collection('credit_spends').doc(String(idemKey))
    : null;
  return db.runTransaction(async (tx) => {
    if (keyRef) {
      const keySnap = await tx.get(keyRef);
      if (keySnap.exists) return true; // already charged for this request
    }
    const snap = await tx.get(ref);
    const current = snap.exists && typeof snap.data().credits === 'number' ? snap.data().credits : 0;
    if (current < cost) return false;
    const balanceAfter = current - cost;
    tx.set(ref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
    if (keyRef) tx.set(keyRef, { cost, at: new Date() });
    recordTransactionInTx(tx, uid, {
      type: 'spend',
      amount: -cost,
      balanceAfter,
      description: description || 'AI generation',
    });
    return true;
  });
}

// Reverse a spend made with `idemKey`. Credits are now taken BEFORE the AI
// call (so concurrent requests can't all pass one balance check), which means
// a generation that fails has already been paid for. This puts the user back
// exactly where they were: balance restored and the idempotency key cleared,
// so a retry is charged fresh rather than silently running free.
// Returns true if a refund happened, false if there was nothing to reverse.
async function refund(uid, idemKey, description) {
  const db = getDb();
  if (!db || !uid || !idemKey) return false;
  const ref = db.collection('users').doc(uid);
  const keyRef = db.collection('users').doc(uid).collection('credit_spends').doc(String(idemKey));
  try {
    return await db.runTransaction(async (tx) => {
      const keySnap = await tx.get(keyRef);
      if (!keySnap.exists) return false; // never charged, or already refunded
      const cost = keySnap.data().cost;
      if (!(cost > 0)) { tx.delete(keyRef); return false; }
      const snap = await tx.get(ref);
      const current = snap.exists && typeof snap.data().credits === 'number' ? snap.data().credits : 0;
      const balanceAfter = current + cost;
      tx.set(ref, { credits: balanceAfter, creditsUpdatedAt: new Date() }, { merge: true });
      tx.delete(keyRef);
      recordTransactionInTx(tx, uid, {
        type: 'refund',
        amount: cost,
        balanceAfter,
        description: description ? `Refund — ${description}` : 'Refund — generation failed',
      });
      return true;
    });
  } catch (e) {
    console.warn('[credits] refund failed:', uid, e.message);
    return false;
  }
}

// Paginated credit history for the Credit History screen (bank-statement
// style) — newest first. Pass `beforeId` (a transaction doc id from a
// previous page) to fetch older entries.
async function getHistory(uid, { limit = 30, beforeId } = {}) {
  const db = getDb();
  if (!db || !uid) return [];
  let q = db
    .collection('users')
    .doc(uid)
    .collection('credit_transactions')
    .orderBy('at', 'desc')
    .limit(limit);
  if (beforeId) {
    const cursorSnap = await db
      .collection('users')
      .doc(uid)
      .collection('credit_transactions')
      .doc(beforeId)
      .get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = {
  getBalance,
  refund,
  ensureSignupBonus,
  grantDailyLoginIfDue,
  claimInstagramFollow,
  claimYoutubeSubscribe,
  grant,
  spend,
  getHistory,
  recordTransactionInTx,
  endpointToCostKey,
  costForPath,
  labelForEndpoint,
  PLAN_CREDITS,
  PACK_CREDITS,
};
