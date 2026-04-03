/**
 * Audit and auto-fix Firestore users collection AI access fields.
 * Run: npm run fix:ai-users (from backend) or node scripts/fix-ai-user-fields.js
 *
 * - Fills missing fields with merge:true (planType, trialStartDate, trialEndDate, dailyAiUsed, dailyAiDate, totalAiUsed).
 * - For trial users: repairs invalid trialEndDate to now+7, resets dailyAiUsed to 0 if > 0.
 * - Does NOT modify premium users, overwrite valid trial dates, or touch subscription status.
 * - Uses batch writes (500 per batch). Handles Firestore timestamps correctly.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDb } = require('../utils/firestoreAdmin');

const USERS = 'users';
const BATCH_SIZE = 500;

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

function snapshotFields(data) {
  return {
    planType: data.planType ?? data.plan_type ?? null,
    trialStartDate: data.trialStartDate ?? data.trialStart ?? null,
    trialEndDate: data.trialEndDate ?? data.trialEnd ?? null,
    dailyAiUsed: typeof (data.dailyAiUsed ?? data.daily_ai_used) === 'number' ? (data.dailyAiUsed ?? data.daily_ai_used) : null,
    dailyAiDate: data.dailyAiDate ?? data.daily_ai_date ?? null,
    totalAiUsed: typeof (data.totalAiUsed ?? data.total_ai_used) === 'number' ? (data.totalAiUsed ?? data.total_ai_used) : null,
  };
}

function toLogValue(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

async function main() {
  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }

  const now = new Date();
  const todayUtc = todayDateStrUtc();
  const trialEndDefault = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const usersSnap = await firestore.collection(USERS).get();
  const totalScanned = usersSnap.size;

  let usersFixed = 0;
  let trialRepaired = 0;
  let usageReset = 0;

  const pendingWrites = [];

  for (const doc of usersSnap.docs) {
    const uid = doc.id;
    const data = doc.data();
    const ref = doc.ref;

    const planType = String(data.planType ?? data.plan_type ?? data.subscriptionPlan ?? '').toLowerCase();
    const isPremium = planType === 'premium' || data.planType === 'premium' || data.isPremium === true || data.subscriptionPlan === 'premium';
    if (isPremium) continue;

    const before = snapshotFields(data);
    const updates = {};
    const fixes = [];

    const hasPlan = (data.planType ?? data.plan_type) != null;
    const hasSubscriptionPlan = data.subscriptionPlan != null && data.subscriptionPlan !== '';
    if (!hasPlan && !hasSubscriptionPlan) {
      updates.planType = 'trial';
      fixes.push('planType=trial');
    }

    if ((data.trialStartDate ?? data.trialStart) == null) {
      updates.trialStartDate = now;
      fixes.push('trialStartDate=now');
    }
    if ((data.trialEndDate ?? data.trialEnd) == null) {
      updates.trialEndDate = trialEndDefault;
      fixes.push('trialEndDate=now+7d');
    }
    if (typeof (data.dailyAiUsed ?? data.daily_ai_used) !== 'number') {
      updates.dailyAiUsed = 0;
      fixes.push('dailyAiUsed=0');
    }
    if (!(data.dailyAiDate ?? data.daily_ai_date)) {
      updates.dailyAiDate = todayUtc;
      fixes.push('dailyAiDate=' + todayUtc);
    }
    if (typeof (data.totalAiUsed ?? data.total_ai_used) !== 'number') {
      updates.totalAiUsed = 0;
      fixes.push('totalAiUsed=0');
    }

    const effectivePlan = (data.planType ?? data.plan_type ?? data.subscriptionPlan ?? 'trial').toString().toLowerCase();
    if (effectivePlan === 'trial') {
      const trialEnd = toDate(data.trialEndDate || data.trialEnd);
      const invalidTrialEnd = !trialEnd || trialEnd < now;
      if (invalidTrialEnd) {
        updates.trialEndDate = trialEndDefault;
        if (!fixes.includes('trialEndDate=now+7d')) fixes.push('trialEndDate=repair(now+7d)');
        trialRepaired++;
      }
      const used = typeof (data.dailyAiUsed ?? data.daily_ai_used) === 'number' ? (data.dailyAiUsed ?? data.daily_ai_used) : 0;
      if (used > 0) {
        updates.dailyAiUsed = 0;
        updates.dailyAiDate = todayUtc;
        if (!fixes.some(f => f.startsWith('dailyAiUsed'))) fixes.push('dailyAiUsed=0(reset)');
        usageReset++;
      }
    }

    if (Object.keys(updates).length === 0) continue;

    usersFixed++;
    const after = { ...before, ...updates };

    console.log(JSON.stringify({
      uid,
      before: {
        planType: before.planType,
        trialStartDate: toLogValue(before.trialStartDate),
        trialEndDate: toLogValue(before.trialEndDate),
        dailyAiUsed: before.dailyAiUsed,
        dailyAiDate: before.dailyAiDate,
        totalAiUsed: before.totalAiUsed,
      },
      after: {
        planType: after.planType ?? updates.planType,
        trialStartDate: updates.trialStartDate != null ? (updates.trialStartDate instanceof Date ? updates.trialStartDate.toISOString() : updates.trialStartDate) : toLogValue(before.trialStartDate),
        trialEndDate: updates.trialEndDate != null ? (updates.trialEndDate instanceof Date ? updates.trialEndDate.toISOString() : updates.trialEndDate) : toLogValue(before.trialEndDate),
        dailyAiUsed: after.dailyAiUsed ?? updates.dailyAiUsed,
        dailyAiDate: after.dailyAiDate ?? updates.dailyAiDate,
        totalAiUsed: after.totalAiUsed ?? updates.totalAiUsed,
      },
      fixes: fixes,
    }));

    pendingWrites.push({ ref, updates });
  }

  for (let i = 0; i < pendingWrites.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    const chunk = pendingWrites.slice(i, i + BATCH_SIZE);
    for (const { ref, updates } of chunk) {
      batch.set(ref, updates, { merge: true });
    }
    await batch.commit();
  }

  console.log('\n--- summary ---');
  console.log('total users scanned:', totalScanned);
  console.log('users fixed:', usersFixed);
  console.log('trial repaired (invalid trialEndDate):', trialRepaired);
  console.log('usage reset (trial dailyAiUsed>0):', usageReset);
  console.log('--- end ---');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
