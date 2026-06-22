/**
 * Find users with a Play purchase token but missing active premiumExpiry.
 * Dry-run by default.
 *
 * Usage:
 *   node scripts/backfill-premium-from-subscription.js           # JSON list only
 *   node scripts/backfill-premium-from-subscription.js --apply   # writes Firestore (use with care)
 *
 * Requires Firebase Admin credentials — see backend/.env.example
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDb, getInitStatus, DEFAULT_PROJECT_ID } = require('../utils/firestoreAdmin');

const DAYS = 30;

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractPurchaseToken(data) {
  const sub = data.subscription;
  const nested = sub && typeof sub === 'object'
    ? (sub.purchaseToken || sub.purchase_token)
    : null;
  const root = data.subscriptionPurchaseToken;
  const token = nested || root;
  if (!token || String(token).trim() === '') return null;
  return String(token).trim();
}

async function main() {
  const apply = process.argv.includes('--apply');
  const status = getInitStatus();

  if (!status.hasCredentialEnv) {
    console.error('Firestore credentials missing.\n');
    console.error('Option A — backend/.env:');
    console.error('  FIREBASE_PROJECT_ID=instaflow-f65a0');
    console.error('  FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"instaflow-f65a0",...}');
    console.error('\nOption B — PowerShell (path to downloaded JSON key):');
    console.error('  $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\to\\instaflow-f65a0-firebase-adminsdk.json"');
    console.error(`  $env:FIREBASE_PROJECT_ID="${DEFAULT_PROJECT_ID}"`);
    console.error('  node scripts/backfill-premium-from-subscription.js');
    console.error('\nGet key: Firebase Console → instaflow-f65a0 → ⚙ Settings → Service accounts → Generate new private key');
    process.exit(1);
  }

  const firestore = getDb();
  if (!firestore) {
    console.error('Firestore not initialized:', status.initError || 'unknown error');
    process.exit(1);
  }

  console.error(`Using project: ${status.projectId}`);

  const now = new Date();
  const snap = await firestore.collection('users').get();
  const candidates = [];

  snap.forEach((doc) => {
    const data = doc.data();
    const token = extractPurchaseToken(data);
    if (!token) return;

    const pe = toDate(data.premiumExpiry);
    const expiryOk = pe != null && pe > now;
    if (expiryOk) return;

    candidates.push({
      uid: doc.id,
      email: data.email || null,
      premiumExpiry: pe ? pe.toISOString() : null,
      subscriptionPlan: data.subscriptionPlan,
      planType: data.planType,
      isPremium: data.isPremium,
      hasSubscriptionVerified: data.subscription?.verified === true,
    });
  });

  console.log(JSON.stringify({ count: candidates.length, apply, candidates }, null, 2));

  if (!apply) {
    console.error('\nDry-run only. Re-run with --apply to set premiumExpiry (+30d), planType, subscriptionPlan, isPremium.');
    return;
  }

  if (candidates.length === 0) {
    console.error('No candidates to update.');
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
