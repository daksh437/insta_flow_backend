/**
 * One-time cleanup after removing Instagram login/publishing/scheduling and
 * Google Calendar (October 2026).
 *
 *   node scripts/cleanup-instagram-calendar.js            # dry run: counts only
 *   node scripts/cleanup-instagram-calendar.js --apply    # delete
 *
 * Deletes:
 *   users/{uid}.instagram (access token + profile fields)
 *   users/{uid}/instagram_data/*
 *   google_tokens/*            (Google Calendar OAuth tokens)
 *   scheduled_posts/*, posting_slots/*
 *   Storage: scheduled_media/**, instagram_publish/**
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS or ./serviceAccountKey.json.
 */
const path = require('path');
const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(require(keyPath)),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'instaflow-f65a0.firebasestorage.app',
});
const db = admin.firestore();

async function deleteDocs(docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

(async () => {
  const report = {};

  const users = await db.collection('users').select('instagram').get();
  const igUsers = users.docs.filter((d) => d.get('instagram') !== undefined);
  report.usersWithInstagramField = igUsers.length;

  const igData = await db.collectionGroup('instagram_data').get();
  report.instagramDataDocs = igData.size;

  const gTokens = await db.collection('google_tokens').get();
  report.googleCalendarTokens = gTokens.size;

  const posts = await db.collection('scheduled_posts').get();
  const slots = await db.collection('posting_slots').get();
  report.scheduledPosts = posts.size;
  report.postingSlots = slots.size;

  const bucket = admin.storage().bucket();
  const files = [];
  for (const prefix of ['scheduled_media/', 'instagram_publish/']) {
    const [f] = await bucket.getFiles({ prefix });
    report[`storage:${prefix}`] = f.length;
    files.push(...f);
  }

  console.log(APPLY ? 'APPLYING:' : 'DRY RUN (nothing deleted):', JSON.stringify(report, null, 2));
  if (!APPLY) process.exit(0);

  const del = admin.firestore.FieldValue.delete();
  for (const d of igUsers) await d.ref.update({ instagram: del });
  await deleteDocs(igData.docs);
  await deleteDocs(gTokens.docs);
  await deleteDocs(posts.docs);
  await deleteDocs(slots.docs);
  await Promise.all(files.map((f) => f.delete().catch(() => {})));
  console.log('Done.');
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
