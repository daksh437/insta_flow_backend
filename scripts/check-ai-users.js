/**
 * Scan all users and report AI access control field issues.
 * Run from backend: node scripts/check-ai-users.js
 *
 * Reports:
 * - Missing fields (planType, trialStartDate, trialEndDate, dailyAiUsed, dailyAiDate, totalAiUsed)
 * - Trial users with dailyAiUsed > 0 (should be 0)
 * - Invalid trial dates (unparseable or trialEndDate < now for trial users)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDb } = require('../utils/firestoreAdmin');

const REQUIRED_KEYS = ['planType', 'trialStartDate', 'trialEndDate', 'dailyAiUsed', 'dailyAiDate', 'totalAiUsed'];

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }

  const now = new Date();
  const usersSnap = await firestore.collection('users').get();

  const missingFields = [];
  const trialWithUsage = [];
  const invalidTrialDates = [];

  usersSnap.docs.forEach((doc) => {
    const uid = doc.id;
    const data = doc.data();

    const missing = REQUIRED_KEYS.filter((k) => {
      const v = data[k] ?? data[k.replace(/([A-Z])/g, (m) => '_' + m.toLowerCase())];
      if (k === 'dailyAiUsed' || k === 'totalAiUsed') return typeof v !== 'number';
      if (k === 'dailyAiDate') return v == null || v === '';
      return v == null;
    });
    if (missing.length) missingFields.push({ uid, missing });

    const planType = String(data.planType ?? data.plan_type ?? data.subscriptionPlan ?? '').toLowerCase();
    const dailyAiUsed = typeof (data.dailyAiUsed ?? data.daily_ai_used) === 'number' ? (data.dailyAiUsed ?? data.daily_ai_used) : 0;
    if (planType === 'trial' && dailyAiUsed > 0) trialWithUsage.push({ uid, dailyAiUsed });

    const trialEnd = toDate(data.trialEndDate || data.trialEnd);
    if (planType === 'trial' && !trialEnd) invalidTrialDates.push({ uid, reason: 'trialEndDate missing or unparseable' });
    else if (planType === 'trial' && trialEnd && trialEnd < now) invalidTrialDates.push({ uid, reason: 'trialEndDate in the past', trialEnd: trialEnd.toISOString() });
  });

  console.log('--- AI users check report ---\n');
  console.log('Total users:', usersSnap.size);
  console.log('');

  if (missingFields.length) {
    console.log('Missing fields:');
    missingFields.forEach(({ uid, missing }) => console.log('  ', uid, '->', missing.join(', ')));
    console.log('');
  } else console.log('Missing fields: none\n');

  if (trialWithUsage.length) {
    console.log('Trial users with dailyAiUsed > 0:');
    trialWithUsage.forEach(({ uid, dailyAiUsed }) => console.log('  ', uid, 'dailyAiUsed=', dailyAiUsed));
    console.log('');
  } else console.log('Trial users with dailyAiUsed > 0: none\n');

  if (invalidTrialDates.length) {
    console.log('Invalid trial dates:');
    invalidTrialDates.forEach(({ uid, reason, trialEnd }) => console.log('  ', uid, reason, trialEnd || ''));
    console.log('');
  } else console.log('Invalid trial dates: none\n');

  console.log('--- end report ---');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
