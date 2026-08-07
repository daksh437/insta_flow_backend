// Credit ledger — server-authoritative. All mutations are atomic (transactions)
// so retries/races never double-grant or double-charge.
const { getDb } = require('../utils/firestoreAdmin');
const { FREE_GRANTS, PLAN_CREDITS, PACK_CREDITS, costForEndpoint } = require('../config/credits');

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Map an AI endpoint path to a credit-cost key.
function endpointToCostKey(endpoint) {
  const p = String(endpoint || '').toLowerCase();
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
  if (p.includes('hook')) return 'caption';
  if (p.includes('ideas') || p.includes('post')) return 'post_ideas';
  return null; // → DEFAULT_COST
}

function costForPath(endpoint) {
  return costForEndpoint(endpointToCostKey(endpoint));
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
      tx.set(ref, {
        credits: current + FREE_GRANTS.NEW_USER_BONUS,
        creditsSignupBonusGranted: true,
        creditsUpdatedAt: new Date(),
      }, { merge: true });
      return true;
    });
    console.log(`[credits] ensureSignupBonus uid=${uid} granted=${granted}`);
  } catch (e) {
    console.warn('[credits] signup bonus failed:', uid, e.message);
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
      tx.set(ref, {
        credits: current + FREE_GRANTS.DAILY_LOGIN,
        creditsDailyDate: today,
        creditsUpdatedAt: new Date(),
      }, { merge: true });
      return true;
    });
    console.log(`[credits] grantDailyLoginIfDue uid=${uid} granted=${granted}`);
  } catch (e) {
    console.warn('[credits] daily grant failed:', uid, e.message);
  }
}

// Grant credits (plan/pack purchase, referral, admin).
async function grant(uid, amount, reason = 'grant') {
  const db = getDb();
  if (!db || !uid || !(amount > 0)) return;
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists && typeof snap.data().credits === 'number' ? snap.data().credits : 0;
    tx.set(ref, { credits: current + Math.floor(amount), creditsUpdatedAt: new Date() }, { merge: true });
  });
  console.log(`[credits] +${amount} to ${uid} (${reason})`);
}

// Spend credits atomically, idempotent by key. Returns true if charged (or
// already charged for this key), false if insufficient balance.
async function spend(uid, cost, idemKey) {
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
    tx.set(ref, { credits: current - cost, creditsUpdatedAt: new Date() }, { merge: true });
    if (keyRef) tx.set(keyRef, { cost, at: new Date() });
    return true;
  });
}

module.exports = {
  getBalance,
  ensureSignupBonus,
  grantDailyLoginIfDue,
  grant,
  spend,
  endpointToCostKey,
  costForPath,
  PLAN_CREDITS,
  PACK_CREDITS,
};
