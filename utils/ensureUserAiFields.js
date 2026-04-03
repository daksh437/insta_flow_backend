/**
 * Ensures user doc has required AI access control fields (Firestore = source of truth).
 * Call after reading user doc so every request self-heals broken/missing fields.
 * Never overwrites existing trialStartDate/trialEndDate if present.
 *
 * New user / missing fields get:
 *   planType, trialStartDate, trialEndDate, dailyAiUsed, dailyAiDate, totalAiUsed
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

  const now = new Date();
  const todayUtc = todayDateStrUtc();
  const trialEndDefault = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const updates = {};

  // New user / missing: planType = trial, trialStartDate = now, trialEndDate = now+7 (only planType is source of truth)
  if (data.planType == null && data.plan_type == null) {
    updates.planType = 'trial';
  }
  if (data.trialStartDate == null && data.trialStart == null) {
    updates.trialStartDate = now;
  }
  if (data.trialEndDate == null && data.trialEnd == null) {
    updates.trialEndDate = trialEndDefault;
    const ptCheck = String((data.planType ?? data.plan_type) || '').toLowerCase();
    if (ptCheck !== 'premium') updates.planType = 'trial';
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
