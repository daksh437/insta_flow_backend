const { getDb, getAdmin } = require('../utils/firestoreAdmin');
const instagramService = require('./instagram_service');

function getUserInstagramAuth(userData = {}) {
  const instagram = userData.instagram || {};
  const token = String(instagram.access_token || '').trim();
  const expiresAt =
    instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
      ? instagram.token_expires_at.toDate()
      : null;
  return { token, expiresAt };
}

async function markFailed(ref, message) {
  const admin = getAdmin();
  const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
  await ref.set(
    {
      status: 'failed',
      updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      lastError: String(message || 'Unknown publish error'),
    },
    { merge: true }
  );
  console.warn(`[Scheduler] ${ref.id} -> failed (${String(message || 'Unknown publish error')})`);
}

async function markPosted(ref, mediaId) {
  const admin = getAdmin();
  const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
  await ref.set(
    {
      status: 'posted',
      mediaId: mediaId || null,
      postedAt: serverTimestamp ? serverTimestamp() : new Date(),
      updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      lastError: null,
    },
    { merge: true }
  );
  console.log(`[Scheduler] ${ref.id} -> posted${mediaId ? ` (mediaId=${mediaId})` : ''}`);
}

async function processDuePost(doc) {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');

  const data = doc.data() || {};
  console.log(`[Scheduler] Processing scheduled post ${doc.id}`);
  const userId = String(data.userId || '').trim();
  if (!userId) {
    await markFailed(doc.ref, 'Missing userId in scheduled post');
    return;
  }

  const userSnap = await db.collection('users').doc(userId).get();
  const user = userSnap.data() || {};
  const { token, expiresAt } = getUserInstagramAuth(user);
  if (!token) {
    await markFailed(doc.ref, 'Instagram token missing. Reconnect Instagram.');
    return;
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    await markFailed(doc.ref, 'Instagram token expired. Reconnect Instagram.');
    return;
  }

  const imageUrl = String(data.imageUrl || '').trim();
  const caption = String(data.caption || '');
  const mediaType = String(data.mediaType || 'image').toLowerCase();
  if (!imageUrl) {
    await markFailed(doc.ref, 'imageUrl missing');
    return;
  }

  const created = await instagramService.createMedia({
    accessToken: token,
    imageUrl: mediaType === 'image' ? imageUrl : null,
    videoUrl: mediaType === 'video' || mediaType === 'reel' ? imageUrl : null,
    caption,
    isReel: mediaType === 'video' || mediaType === 'reel',
  });
  const creationId = String(created?.id || '').trim();
  if (!creationId) {
    await markFailed(doc.ref, 'Failed to create media container');
    return;
  }

  const published = await instagramService.publishMedia({
    accessToken: token,
    creationId,
  });

  await markPosted(doc.ref, String(published?.id || ''));
}

async function processPendingScheduledPosts() {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[Scheduler] Firestore unavailable, skipping cron tick');
      return;
    }

    const now = new Date();
    const pendingSnap = await db
      .collection('scheduled_posts')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .limit(25)
      .get();

    if (pendingSnap.empty) {
      return;
    }

    for (const doc of pendingSnap.docs) {
      try {
        await processDuePost(doc);
      } catch (error) {
        await markFailed(doc.ref, error?.message || 'Failed to publish scheduled post');
      }
    }
  } catch (error) {
    console.error('[Scheduler] processPendingScheduledPosts failed:', error?.message || error);
  }
}

module.exports = {
  processPendingScheduledPosts,
};
