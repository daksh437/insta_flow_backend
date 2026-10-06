/**
 * Ensures user doc has required AI access control fields (Firestore = source of truth).
 * Call after reading user doc so every request self-heals broken/missing fields.
 * Never overwrites existing trialStartDate/trialEndDate if present.
 *
 * Missing fields get: planType ('free'), dailyAiUsed, dailyAiDate, totalAiUsed.
 * No trial dates are created any more.
 * with merge: true; returns merged object.
 */

const { getDb } = require('./firestoreAdmin');

function todayDateStrUtc() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Ensure user doc has: planType, trialStartDate, trialEndDate, dailyAiUsed, dailyAiDate, totalAiUsed.
 * Fill missing fields only; never overwrite existing trialStartDate/trialEndDate.
 * Uses merge: true. Returns merged object (does not re-read from Firestore).
 *
 * @param {FirebaseFirestore.DocumentReference} userDocRef - Reference to users/{uid}
 * @param {object} data - Current doc data (snap.data())
 * @returns {Promise<object>} Updated data (merged with any writes).
 */
async function ensureUserAiFields(userDocRef, data) {
  if (!userDocRef || !data) return data;
  const firestore = getDb();
  if (!firestore) return data;

  const todayUtc = todayDateStrUtc();
  const updates = {};

  // No more automatic 3-day trial: it used to be stamped here on every user
  // doc missing trial dates. Access now comes from credits and the Play
  // subscription entitlement (services/entitlement.js). Existing trial dates
  // are left untouched (read-only, legacy).
  if (data.planType == null && data.plan_type == null) {
    updates.planType = 'free';
  }
  if (typeof (data.dailyAiUsed ?? data.daily_ai_used) !== 'number') {
    updates.dailyAiUsed = 0;
  }
  if (!(data.dailyAiDate ?? data.daily_ai_date)) {
    updates.dailyAiDate = todayUtc;
  }
  if (typeof (data.totalAiUsed ?? data.total_ai_used) !== 'number') {
    updates.totalAiUsed = 0;
  }

  // Do NOT overwrite planType from dates here. getAiAccess + planResolver is the single source of truth.

  if (Object.keys(updates).length === 0) return data;

  try {
    await userDocRef.set(updates, { merge: true });
    return { ...data, ...updates };
  } catch (e) {
    console.warn('[ensureUserAiFields] write error:', e.message);
    return data;
  }
}

module.exports = { ensureUserAiFields, todayDateStrUtc };
