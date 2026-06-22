const { getDb, getAdmin } = require('../utils/firestoreAdmin');
const instagramService = require('./instagram_service');
const { isIndexMissingError, logIndexRequirement } = require('../utils/firestoreIndexGuard');
const axios = require('axios');
const sharp = require('sharp');
const CLAIM_TTL_MS = 2 * 60 * 1000;

function getUserInstagramAuth(userData = {}) {
  const instagram = userData.instagram || {};
  const token = String(instagram.access_token || '').trim();
  const expiresAt =
    instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
      ? instagram.token_expires_at.toDate()
      : null;
  return { token, expiresAt };
}

function isValidUrl(url) {
  const u = String(url || '').trim();
  return (
    u.startsWith('https://') &&
    (u.startsWith('https://firebasestorage.googleapis.com') ||
      u.startsWith('https://storage.googleapis.com'))
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldClaimPost(data, nowMs = Date.now()) {
  const status = String(data?.status || '');
  if (status !== 'pending') return false;
  const lockedUntilRaw = data?.processing?.lockedUntilMs;
  const lockedUntilMs = Number(lockedUntilRaw || 0);
  return !lockedUntilMs || lockedUntilMs <= nowMs;
}

async function claimScheduledPost(ref, workerId, nowMs = Date.now()) {
  const db = getDb();
  if (!db) return false;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (!shouldClaimPost(data, nowMs)) return false;
    tx.set(
      ref,
      {
        status: 'processing',
        processing: {
          workerId,
          lockedAtMs: nowMs,
          lockedUntilMs: nowMs + CLAIM_TTL_MS,
        },
        updatedAt: new Date(nowMs),
      },
      { merge: true }
    );
    return true;
  });
}

/** Short code for clients/logs; keep lastError as human-readable string. */
function inferErrorCode(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('token missing')) return 'IG_TOKEN_MISSING';
  if (m.includes('token expired') || m.includes('reconnect instagram')) return 'IG_TOKEN_EXPIRED';
  if (m.includes('missing userid')) return 'MISSING_USER_ID';
  if (m.includes('imageurl') && m.includes('missing')) return 'MISSING_MEDIA_URL';
  if (m.includes('invalid_image_url')) return 'INVALID_IMAGE_URL';
  if (m.includes('preprocessing')) return 'IMAGE_PREPROCESS_FAILED';
  if (m.includes('media creation failed')) return 'MEDIA_CREATE_FAILED';
  if (m.includes('instagram rejected')) return 'IG_MEDIA_REJECTED';
  if (m.includes('media processing failed') || m.includes('processing timeout')) return 'MEDIA_PROCESS_FAILED';
  if (m.includes('publish')) return 'IG_PUBLISH_FAILED';
  return 'SCHEDULER_ERROR';
}

async function createMediaWithRetry(data, retries = 3) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const id = await instagramService.createMedia(data);
      if (id) return id;
    } catch (_e) {
      console.log(`Retry ${i + 1} failed`);
    }
    await wait(3000);
  }
  throw new Error('Media creation failed after retries');
}

function isValidRatio(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return (
    Math.abs(ratio - 1) < 0.01 || // 1:1
    Math.abs(ratio - 0.8) < 0.01 || // 4:5
    Math.abs(ratio - 1.91) < 0.05 // 1.91:1
  );
}

async function waitForMediaReady(creationId, accessToken) {
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await axios.get(`https://graph.facebook.com/v18.0/${creationId}`, {
        params: {
          fields: 'status_code',
          access_token: accessToken,
        },
        timeout: 25000,
      });
      const statusCode = String(res.data?.status_code || '').toUpperCase();
      console.log('Media status:', statusCode || 'UNKNOWN');
      if (statusCode === 'FINISHED') return true;
      if (statusCode === 'ERROR') {
        console.error('Instagram error:', res.data);
        throw new Error('Instagram media processing failed');
      }
    } catch (error) {
      console.error('Instagram error:', error?.response?.data || error?.message);
      throw error;
    }
    await wait(3000);
  }
  throw new Error('Media processing timeout');
}

async function fixImageRatio(imageUrl) {
  const response = await axios({
    url: imageUrl,
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to download source image (${response.status})`);
  }

  const buffer = Buffer.from(response.data);
  const metadata = await sharp(buffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!isValidRatio(width, height)) {
    console.log(`[Scheduler] Unsupported ratio (${width}x${height}), auto-fixing to 4:5`);
  }
  const resized = await sharp(buffer)
    .resize(1080, 1350, { fit: 'cover', position: 'center' }) // Instagram 4:5
    .jpeg({ quality: 90 })
    .toBuffer();
  return resized;
}

async function uploadProcessedImage({ userId, docId, imageBuffer }) {
  const admin = getAdmin();
  const storage = admin?.storage ? admin.storage() : null;
  if (!storage) throw new Error('Firebase Storage admin unavailable');
  const bucket = storage.bucket();
  if (!bucket) throw new Error('Firebase Storage bucket unavailable');

  const objectPath = `scheduler_processed/${userId}/${docId}_${Date.now()}.jpg`;
  const file = bucket.file(objectPath);
  await file.save(imageBuffer, {
    metadata: { contentType: 'image/jpeg' },
    resumable: false,
  });
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 24 * 60 * 60 * 1000,
  });
  return signedUrl;
}

async function markFailed(ref, message) {
  const admin = getAdmin();
  const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
  const errMsg = String(message || 'Unknown publish error');
  const errCode = inferErrorCode(errMsg);
  const snap = await ref.get().catch(() => null);
  const current = snap?.data ? snap.data() || {} : {};
  const retryCount = Number(current.retryCount || 0);
  if (retryCount < 3) {
    await ref.set(
      {
        status: 'pending',
        processing: null,
        retryCount: retryCount + 1,
        lastRetryAt: serverTimestamp ? serverTimestamp() : new Date(),
        updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
        lastError: errMsg,
        lastErrorCode: errCode,
        scheduledAt: new Date(Date.now() + 3 * 60 * 1000),
      },
      { merge: true }
    );
    console.warn(`[Retry] ${ref.id} code=${errCode} retry ${retryCount + 1}/3 (${errMsg})`);
    return;
  }
  await ref.set(
    {
      status: 'failed',
      processing: null,
      updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      lastError: errMsg,
      lastErrorCode: errCode,
    },
    { merge: true }
  );
  console.warn(`[Scheduler] ${ref.id} -> failed after retries code=${errCode} (${errMsg})`);
}

async function markPosted(ref, mediaId) {
  const admin = getAdmin();
  const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
  await ref.set(
    {
      status: 'posted',
      processing: null,
      mediaId: mediaId || null,
      postedAt: serverTimestamp ? serverTimestamp() : new Date(),
      updatedAt: serverTimestamp ? serverTimestamp() : new Date(),
      lastError: null,
      lastErrorCode: null,
    },
    { merge: true }
  );
  console.log(`[Scheduler] ${ref.id} -> posted${mediaId ? ` (mediaId=${mediaId})` : ''}`);
}

async function processDuePost(ref, workerId) {
  const db = getDb();
  if (!db) throw new Error('Firestore unavailable');

  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  const owner = String(data?.processing?.workerId || '');
  if (owner && owner !== workerId) return;
  console.log(`[Scheduler] Processing scheduled post ${snap.id}`);
  const userId = String(data.userId || '').trim();
  if (!userId) {
    await markFailed(ref, 'Missing userId in scheduled post');
    return;
  }

  const userSnap = await db.collection('users').doc(userId).get();
  const user = userSnap.data() || {};
  const { token, expiresAt } = getUserInstagramAuth(user);
  if (!token) {
    await markFailed(ref, 'Instagram token missing. Reconnect Instagram.');
    return;
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    await markFailed(ref, 'Instagram token expired. Reconnect Instagram.');
    return;
  }

  const imageUrls = Array.isArray(data.imageUrls)
    ? data.imageUrls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const imageUrl = String(data.imageUrl || imageUrls[0] || '').trim();
  const caption = String(data.caption || '');
  const mediaType = String(data.mediaType || 'image').toLowerCase();
  const scheduledAt = data.scheduledAt?.toDate ? data.scheduledAt.toDate() : data.scheduledAt;
  console.log('[Scheduler] 📅 Scheduled Post Data:', {
    docId: snap.id,
    userId,
    imageUrl,
    captionLength: caption.length,
    scheduledAt,
    mediaType,
  });
  if (!imageUrl && imageUrls.length === 0) {
    await markFailed(ref, 'imageUrl/imageUrls missing');
    return;
  }
  const allUrls = imageUrls.length > 0 ? imageUrls : [imageUrl];
  if (allUrls.some((u) => !isValidUrl(u))) {
    await markFailed(ref, 'INVALID_IMAGE_URL');
    return;
  }
  console.log('Image URL:', imageUrl);
  console.log('Caption:', caption);

  let publishImageUrl = imageUrl;
  let publishImageUrls = allUrls;
  if (mediaType === 'image') {
    try {
      const processedUrls = [];
      for (let i = 0; i < allUrls.length; i += 1) {
        const resizedBuffer = await fixImageRatio(allUrls[i]);
        const processedUrl = await uploadProcessedImage({
          userId,
          docId: `${snap.id}_${i}`,
          imageBuffer: resizedBuffer,
        });
        processedUrls.push(processedUrl);
      }
      publishImageUrls = processedUrls;
      publishImageUrl = processedUrls[0];
      console.log('[Scheduler] Image(s) resized to 4:5 and uploaded:', publishImageUrls.length);
    } catch (error) {
      console.error('[Scheduler] Failed to preprocess image ratio:', error?.message || error);
      await markFailed(ref, `Image preprocessing failed: ${error?.message || 'unknown error'}`);
      return;
    }
  }

  let mediaId;
  try {
    if (mediaType === 'image' && publishImageUrls.length > 1) {
      const childIds = [];
      for (const url of publishImageUrls) {
        const childId = await createMediaWithRetry({
          accessToken: token,
          imageUrl: url,
          caption: '',
          isReel: false,
          isCarouselItem: true,
        });
        childIds.push(childId);
      }
      mediaId = await createMediaWithRetry({
        accessToken: token,
        imageUrl: null,
        caption,
        children: childIds,
        isCarousel: true,
      });
    } else {
      mediaId = await createMediaWithRetry({
        accessToken: token,
        imageUrl: mediaType === 'image' ? publishImageUrl : null,
        videoUrl: mediaType === 'video' || mediaType === 'reel' ? publishImageUrl : null,
        caption,
        isReel: mediaType === 'video' || mediaType === 'reel',
      });
    }
  } catch (error) {
    console.error('Instagram error:', error?.response?.data || error?.message);
    await markFailed(ref, 'Media creation failed (invalid image)');
    return;
  }
  mediaId = String(mediaId || '').trim();
  if (!mediaId) {
    console.log(`[Scheduler] ⏳ Retrying media creation for ${snap.id}...`);
    await wait(5000);
    try {
      mediaId = await createMediaWithRetry({
        accessToken: token,
        imageUrl: mediaType === 'image' ? imageUrl : null,
        videoUrl: mediaType === 'video' || mediaType === 'reel' ? imageUrl : null,
        caption,
        isReel: mediaType === 'video' || mediaType === 'reel',
      });
    } catch (error) {
      console.error('Instagram error:', error?.response?.data || error?.message);
      await markFailed(ref, 'Media creation failed (invalid image)');
      return;
    }
    mediaId = String(mediaId || '').trim();
  }
  const creationId = mediaId;
  if (!creationId) {
    await markFailed(ref, 'Instagram rejected media');
    return;
  }
  console.log('Image URL:', publishImageUrl);
  console.log('Media created:', creationId);
  console.log('Creation ID:', creationId);

  await waitForMediaReady(creationId, token);
  console.log('Publishing media:', creationId);
  const published = await instagramService.publishMedia({
    accessToken: token,
    creationId,
  });

  await markPosted(ref, String(published?.id || ''));
  console.log(`[Scheduler] Publish success doc=${snap.id} mediaId=${String(published?.id || '')}`);
}

async function processPendingScheduledPosts() {
  try {
    const db = getDb();
    if (!db) {
      console.warn('[Scheduler] Firestore unavailable, skipping cron tick');
      return;
    }

    const now = new Date();
    let pendingSnap;
    try {
      pendingSnap = await db
        .collection('scheduled_posts')
        .where('status', '==', 'pending')
        .where('scheduledAt', '<=', now)
        .limit(25)
        .get();
    } catch (error) {
      if (isIndexMissingError(error)) {
        logIndexRequirement({
          queryName: 'scheduler.processPendingScheduledPosts',
          collection: 'scheduled_posts',
          fields: ['status ASC', 'scheduledAt ASC'],
          error,
        });
        console.warn('[Scheduler] Firestore index not ready. Skipping this cron tick.');
        return;
      }
      throw error;
    }

    if (pendingSnap.empty) {
      return;
    }

    const workerId = `worker-${process.pid}-${Date.now()}`;
    for (const doc of pendingSnap.docs) {
      try {
        const claimed = await claimScheduledPost(doc.ref, workerId);
        if (!claimed) continue;
        await processDuePost(doc.ref, workerId);
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
  __test: {
    shouldClaimPost,
    claimScheduledPost,
  },
};
