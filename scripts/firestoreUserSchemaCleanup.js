/**
 * PART 1 — Firestore users schema cleanup.
 * Normalize users/{uid} to only: planType, trialStartDate, trialEndDate, premiumStartDate, premiumExpiry, dailyAiUsed, dailyAiDate, createdAt (+ other profile data).
 * Removes: subscriptionPlan, subscriptionType, premiumPlan, premiumDuration, trialEnd, dailyFreeUsedCount, isPremium, isTrialActive, plan_type, trial_start, trial_end, daily_ai_used, daily_ai_date, total_ai_used, premium_expiry.
 * Run from backend: node scripts/firestoreUserSchemaCleanup.js
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
  'premiumPlan',
  'premiumDuration',
  'trialEnd',
  'dailyFreeUsedCount',
  'isPremium',
  'isTrialActive',
  'plan_type',
  'trial_start',
  'trial_end',
  'daily_ai_used',
  'daily_ai_date',
  'total_ai_used',
  'premium_expiry',
];

async function main() {
  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized.');
    process.exit(1);
  }

  const usersSnap = await firestore.collection(USERS).get();
  const updates = [];

  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const write = {};
    for (const key of FIELDS_TO_REMOVE) {
      if (data[key] !== undefined) {
        write[key] = FieldValue.delete();
      }
    }
    if (Object.keys(write).length === 0) continue;
    updates.push({ ref: doc.ref, write, uid: doc.id });
  }

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    const chunk = updates.slice(i, i + BATCH_SIZE);
    for (const { ref, write } of chunk) {
      batch.update(ref, write);
    }
    await batch.commit();
  }

  console.log('firestoreUserSchemaCleanup: removed legacy fields from', updates.length, 'users');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
