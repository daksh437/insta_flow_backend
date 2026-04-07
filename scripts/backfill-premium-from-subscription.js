/**
 * Find users with subscription.verified == true + purchaseToken but missing root premiumExpiry
 * (or inconsistent plan fields). Dry-run by default.
 *
 * Usage:
 *   node scripts/backfill-premium-from-subscription.js           # JSON list only
 *   node scripts/backfill-premium-from-subscription.js --apply   # writes Firestore (use with care)
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS (see utils/firestoreAdmin).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDb } = require('../utils/firestoreAdmin');

const DAYS = 30;

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized.');
    process.exit(1);
  }

  const now = new Date();
  const snap = await firestore.collection('users').get();
  const candidates = [];

  snap.forEach((doc) => {
    const data = doc.data();
    const sub = data.subscription;
    if (!sub || typeof sub !== 'object') return;
    if (sub.verified !== true) return;
    const token = sub.purchaseToken || sub.purchase_token;
    if (!token || String(token).trim() === '') return;

    const pe = toDate(data.premiumExpiry);
    const expiryOk = pe != null && pe > now;
    if (expiryOk) return;

    candidates.push({
      uid: doc.id,
      premiumExpiry: pe ? pe.toISOString() : null,
      subscriptionPlan: data.subscriptionPlan,
      planType: data.planType,
      isPremium: data.isPremium,
    });
  });

  console.log(JSON.stringify({ count: candidates.length, apply, candidates }, null, 2));

  if (!apply) {
    console.error('\nDry-run only. Re-run with --apply to set premiumExpiry (+30d), planType, subscriptionPlan, isPremium.');
    return;
  }

  const admin = require('firebase-admin');
  const Timestamp = admin.firestore.Timestamp;
  const future = new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000);
  const futureTs = Timestamp.fromDate(future);
  let batch = firestore.batch();
  let ops = 0;
  let total = 0;

  for (const c of candidates) {
    const ref = firestore.collection('users').doc(c.uid);
    batch.update(ref, {
      premiumExpiry: futureTs,
      planType: 'premium',
      subscriptionPlan: 'pro',
      isPremium: true,
      lastUpdated: Timestamp.now(),
    });
    ops += 1;
    total += 1;
    if (ops >= 450) {
      await batch.commit();
      batch = firestore.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.error(`Applied updates to ${total} user document(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
