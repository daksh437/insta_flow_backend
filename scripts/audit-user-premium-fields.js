/**
 * READ-ONLY: Sample users/{uid} and report premium-related field presence and inconsistencies.
 *
 * Run:  cd backend && node scripts/audit-user-premium-fields.js
 * Requires: FIREBASE_SERVICE_ACCOUNT_JSON or default credentials (same as other scripts).
 *
 * Does NOT delete or modify any document.
 *
 * Migration notes (manual / one-off script — do NOT delete purchaseToken):
 * - Backfill: if premiumExpiry > now && subscriptionPlan is not pro/ultra, set subscriptionPlan + planType.
 * - Do not remove subscription.*, isPremium, premiumProductId until a server verifier exists.
 * - Firestore rules: users may update own doc except server-only keys (see firestore.rules).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDb } = require('../utils/firestoreAdmin');

const TRACKED = [
  'planType',
  'plan_type',
  'subscriptionPlan',
  'isPremium',
  'premiumExpiry',
  'premiumProductId',
  'subscription',
  'premiumVerified',
  'trialEnd',
  'trialEndDate',
  'trialExpiry',
];

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

  const snap = await firestore.collection('users').limit(500).get();
  const fieldCounts = {};
  TRACKED.forEach((k) => {
    fieldCounts[k] = 0;
  });

  const inconsistent = [];
  const now = new Date();

  snap.forEach((doc) => {
    const data = doc.data();
    TRACKED.forEach((k) => {
      if (data[k] !== undefined && data[k] !== null) fieldCounts[k] += 1;
    });
    const pe = toDate(data.premiumExpiry);
    const activePremium = pe != null && pe > now;
    const sp = (data.subscriptionPlan || '').toString().toLowerCase();
    if (activePremium && sp !== 'pro' && sp !== 'ultra') {
      inconsistent.push({
        uid: doc.id,
        premiumExpiry: pe && pe.toISOString(),
        subscriptionPlan: data.subscriptionPlan,
        planType: data.planType,
      });
    }
  });

  console.log(JSON.stringify({ sampled: snap.size, fieldCounts, inconsistentPremiumVsSubscriptionPlan: inconsistent }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
