#!/usr/bin/env node
/**
 * Backfill users/{uid} profiles that the signup race left empty (fixed in app
 * 1.0.38): docs with no createdAt get createdAt / email / displayName /
 * photoURL / authProvider from Firebase Auth. Only missing fields are
 * written; nothing else is touched. Users not in Auth are skipped.
 *
 *   node scripts/backfill-user-profiles.js           # dry run (read-only)
 *   node scripts/backfill-user-profiles.js --apply   # write
 */
const { getAdmin, getDb } = require('../utils/firestoreAdmin');

const APPLY = process.argv.includes('--apply');

function providerOf(authUser) {
  const ids = (authUser.providerData || []).map((p) => p.providerId);
  if (ids.includes('google.com')) return 'google';
  if (ids.includes('password')) return 'email';
  return ids[0] || 'unknown';
}

(async () => {
  const db = getDb();
  const auth = getAdmin().auth();
  const snap = await db.collection('users').get();
  const broken = snap.docs.filter((d) => !d.data().createdAt);
  let fixed = 0, notInAuth = 0;
  for (const doc of broken) {
    const data = doc.data();
    let a;
    try {
      a = await auth.getUser(doc.id);
    } catch (e) {
      notInAuth++;
      continue;
    }
    const patch = { createdAt: new Date(a.metadata.creationTime) };
    if (data.email == null && a.email) patch.email = a.email;
    if (data.displayName == null && a.displayName) patch.displayName = a.displayName;
    if (data.photoURL == null && a.photoURL) patch.photoURL = a.photoURL;
    if (data.authProvider == null) patch.authProvider = providerOf(a);
    if (APPLY) await doc.ref.set(patch, { merge: true });
    fixed++;
    console.log(`${APPLY ? 'fixed' : 'would fix'} ${doc.id.slice(0, 8)}… fields=${Object.keys(patch).join(',')}`);
  }
  console.log(`\nusers=${snap.size} withoutCreatedAt=${broken.length} ${APPLY ? 'fixed' : 'wouldFix'}=${fixed} notInAuth=${notInAuth}${APPLY ? '' : '  (dry run; add --apply to write)'}`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
