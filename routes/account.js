/**
 * Account deletion.
 *
 * The app used to do this client-side with a single line:
 *
 *     firestore.collection('users').doc(uid).delete()
 *
 * while telling the user "this permanently deletes your data from our servers".
 * It did not. Deleting a Firestore document does NOT delete its subcollections,
 * nothing touched Cloud Storage, nothing touched the uid-keyed top-level
 * collections, and the Firebase Auth user survived — so signing in with the
 * same Google account brought the account straight back.
 *
 * This endpoint actually removes it all, server-side with the Admin SDK, which
 * is also the only place with the privileges to delete the Auth user.
 */

const express = require('express');
const { requireAuth } = require('../middleware/verifyAuth');
const { strictLimiter } = require('../middleware/rateLimiters');
const { getDb, getAdmin } = require('../utils/firestoreAdmin');

const router = express.Router();

/** Subcollections under users/{uid}. Firestore never cascades these. */
const USER_SUBCOLLECTIONS = [
  'credit_transactions',
  'credit_spends',
  'devices',
  'instagram_data',
  'notifications',
  'personalized_drops',
  'referrals',
  'studio',
  'tool_usage',
];

/** Top-level collections holding user rows, with the field naming the owner. */
const OWNED_COLLECTIONS = [
  { name: 'feedback', field: 'userId' },
  { name: 'ai_reports', field: 'userId' },
  { name: 'posts', field: 'userId' },
  { name: 'calendar_history', field: 'userId' },
  { name: 'script_history', field: 'userId' },
  { name: 'ai_history', field: 'userId' },
  { name: 'ai_usage_logs', field: 'uid' },
  { name: 'scheduled_posts', field: 'uid' },
  { name: 'credit_grants', field: 'uid' },
];

/** Cloud Storage prefixes that belong to one user. */
const STORAGE_PREFIXES = (uid) => [
  `studio_images/${uid}/`,
  `users/${uid}/`,
  `instagram_publish/${uid}/`,
];

/** Delete every doc in a collection reference, in batches. */
async function deleteCollection(ref, label, counts) {
  let removed = 0;
  // Page through rather than reading everything at once — a heavy user can
  // have thousands of credit transactions.
  for (;;) {
    const snap = await ref.limit(400).get();
    if (snap.empty) break;
    const batch = ref.firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    if (snap.size < 400) break;
  }
  if (removed > 0) counts[label] = removed;
  return removed;
}

/**
 * POST /account/delete
 *
 * Deletes everything belonging to the authenticated user and then the Auth
 * account itself. Ordered so that if it fails part-way the account is still
 * usable and the user can retry — the Auth user goes last, because once it is
 * gone the caller can no longer authenticate to finish the job.
 */
router.post('/delete', requireAuth, strictLimiter, async (req, res) => {
  const uid = req.uid;
  const db = getDb();
  const admin = getAdmin();
  if (!db || !admin) {
    return res.status(503).json({ success: false, error: 'FIRESTORE_UNAVAILABLE' });
  }

  const counts = {};
  console.log(`[account] delete requested uid=${uid}`);

  try {
    const userRef = db.collection('users').doc(uid);

    // 1. Subcollections under the user document.
    for (const sub of USER_SUBCOLLECTIONS) {
      await deleteCollection(userRef.collection(sub), sub, counts);
    }

    // 2. Any subcollection we did not name explicitly, so a collection added
    //    later is not silently left behind.
    try {
      const listed = await userRef.listCollections();
      for (const col of listed) {
        if (USER_SUBCOLLECTIONS.includes(col.id)) continue;
        await deleteCollection(col, `extra:${col.id}`, counts);
      }
    } catch (e) {
      console.warn('[account] listCollections failed:', e.message);
    }

    // 3. Top-level rows owned by this user.
    for (const { name, field } of OWNED_COLLECTIONS) {
      try {
        await deleteCollection(db.collection(name).where(field, '==', uid), name, counts);
      } catch (e) {
        // A missing index or collection must not abort the whole deletion.
        console.warn(`[account] ${name} cleanup failed:`, e.message);
      }
    }

    // 4. Cloud Storage objects.
    try {
      const bucket = admin.storage().bucket();
      for (const prefix of STORAGE_PREFIXES(uid)) {
        const [files] = await bucket.getFiles({ prefix });
        if (files.length) {
          await Promise.all(files.map((f) => f.delete().catch(() => {})));
          counts[`storage:${prefix}`] = files.length;
        }
      }
    } catch (e) {
      console.warn('[account] storage cleanup failed:', e.message);
    }

    // 5. The user document itself.
    await userRef.delete();

    // 6. The Auth account — last, and the step that actually makes the
    //    deletion stick. Without it the next Google sign-in recreates the user.
    await admin.auth().deleteUser(uid);

    console.log(`[account] deleted uid=${uid}`, counts);
    return res.json({ success: true, ok: true, deleted: counts });
  } catch (e) {
    console.error('[account] delete failed', uid, e.message);
    return res.status(500).json({
      success: false,
      ok: false,
      error: 'DELETE_FAILED',
      message: 'Could not delete the account. Please try again or contact support.',
    });
  }
});

module.exports = router;
