/**
 * Normalize users collection to use ONLY planType as source of truth.
 * Run: node scripts/normalizeUserPlanFields.js (from backend)
 *
 * 1. Determines final planType from existing planType or legacy fields.
 * 2. Removes: subscriptionPlan, subscriptionType, isTrialActive, isPremium, premiumPlan, premiumDuration, trialStart, trialEnd.
 * 3. Keeps only: planType, trialStartDate, trialEndDate, dailyAiUsed, dailyAiDate, totalAiUsed (plus other user fields untouched).
 * 4. Uses batch updates (500 per batch). Logs every updated user.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const admin = require('firebase-admin');
const { getDb } = require('../utils/firestoreAdmin');

const USERS = 'users';
const BATCH_SIZE = 500;
const { FieldValue } = admin.firestore;

const FIELDS_TO_REMOVE = [
  'subscriptionPlan',
  'subscriptionType',
  'isTrialActive',
  'isPremium',
  'premiumPlan',
  'premiumDuration',
  'trialStart',
  'trialEnd',
];

function resolvePlanType(data) {
  const planType = (data.planType ?? data.plan_type ?? '').toString().trim().toLowerCase();
  if (planType === 'trial' || planType === 'free' || planType === 'premium') return planType;
  const sub = (data.subscriptionPlan ?? '').toString().trim().toLowerCase();
  if (sub === 'trial') return 'trial';
  if (sub === 'premium' || sub === 'pro' || sub === 'ultra') return 'premium';
  if (data.isPremium === true) return 'premium';
  return 'free';
}

async function main() {
  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized.');
    process.exit(1);
  }

  const usersSnap = await firestore.collection(USERS).get();
  const updates = [];

  for (const doc of usersSnap.docs) {
    const uid = doc.id;
    const data = doc.data();
    const planType = resolvePlanType(data);

    const write = { planType };
    const removed = [];
    for (const key of FIELDS_TO_REMOVE) {
      if (data[key] !== undefined) {
        write[key] = FieldValue.delete();
        removed.push(key);
      }
    }

    const planChanged = (data.planType !== planType && data.plan_type !== planType);
    if (removed.length === 0 && !planChanged) continue;

    updates.push({ ref: doc.ref, write, uid, planType, removed });
    console.log(JSON.stringify({ uid, planType, removed }));
  }

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    const chunk = updates.slice(i, i + BATCH_SIZE);
    for (const { ref, write } of chunk) {
      batch.update(ref, write);
    }
    await batch.commit();
  }

  console.log('\n--- normalizeUserPlanFields ---');
  console.log('total users scanned:', usersSnap.size);
  console.log('users updated:', updates.length);
  console.log('--- end ---');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
