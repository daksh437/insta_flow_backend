const { getDb, getAdmin } = require('../utils/firestoreAdmin');

function getUserId(req) {
  return String(
    req.headers['x-user-uid'] ||
      req.headers['x-user-id'] ||
      req.body?.userId ||
      req.query?.userId ||
      ''
  ).trim();
}

function parseDate(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function sendError(res, error, fallback = 'Something went wrong') {
  const status = Number(error?.status || 500);
  const message = String(error?.message || fallback);
  return res.status(status).json({
    success: false,
    error: {
      message,
      code: String(error?.code || 'SCHEDULER_ERROR'),
    },
  });
}

async function schedulePost(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId (or x-user-uid header).', code: 'VALIDATION_ERROR' },
    });
  }

  const imageUrl = String(req.body?.imageUrl || req.body?.mediaUrl || '').trim();
  const caption = String(req.body?.caption || '').trim();
  const mediaType = String(req.body?.mediaType || 'image').toLowerCase();
  const scheduledAt = parseDate(req.body?.scheduledAt);

  if (!imageUrl) {
    return res.status(400).json({ success: false, error: { message: 'imageUrl is required.', code: 'VALIDATION_ERROR' } });
  }
  if (!caption) {
    return res.status(400).json({ success: false, error: { message: 'caption is required.', code: 'VALIDATION_ERROR' } });
  }
  if (!['image', 'video', 'reel'].includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error: { message: 'mediaType must be "image" or "video".', code: 'VALIDATION_ERROR' },
    });
  }
  if (!scheduledAt) {
    return res.status(400).json({
      success: false,
      error: { message: 'scheduledAt must be a valid date-time.', code: 'VALIDATION_ERROR' },
    });
  }
  if (scheduledAt.getTime() <= Date.now()) {
    return res.status(400).json({
      success: false,
      error: { message: 'scheduledAt must be in the future.', code: 'VALIDATION_ERROR' },
    });
  }

  try {
    const db = getDb();
    const admin = getAdmin();
    if (!db) {
      return res
        .status(500)
        .json({ success: false, error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' } });
    }
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore admin unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }

    const payload = {
      userId,
      imageUrl,
      caption,
      scheduledAt,
      status: 'pending',
      mediaType: mediaType === 'video' || mediaType === 'reel' ? 'video' : 'image',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      mediaId: null,
      postedAt: null,
      lastError: null,
    };

    const ref = await db.collection('scheduled_posts').add(payload);
    console.log(`[Scheduler] Scheduled post created: ${ref.id} (userId=${userId})`);
    return res.status(201).json({
      success: true,
      id: ref.id,
      data: {
        userId: payload.userId,
        imageUrl: payload.imageUrl,
        caption: payload.caption,
        mediaType: payload.mediaType,
        status: payload.status,
        scheduledAt: scheduledAt.toISOString(),
      },
    });
  } catch (error) {
    return sendError(res, error, 'Failed to schedule post.');
  }
}

async function getScheduledPosts(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId (or x-user-uid header).', code: 'VALIDATION_ERROR' },
    });
  }

  try {
    const db = getDb();
    if (!db) {
      return res
        .status(500)
        .json({ success: false, error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' } });
    }

    const snap = await db
      .collection('scheduled_posts')
      .where('userId', '==', userId)
      .orderBy('scheduledAt', 'desc')
      .get();

    const posts = snap.docs.map((doc) => {
      const d = doc.data() || {};
      const scheduledAt = d.scheduledAt?.toDate ? d.scheduledAt.toDate() : null;
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      return {
        id: doc.id,
        userId: String(d.userId || ''),
        imageUrl: String(d.imageUrl || ''),
        caption: String(d.caption || ''),
        scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
        status: String(d.status || 'pending'),
        createdAt: createdAt ? createdAt.toISOString() : null,
        mediaType: String(d.mediaType || 'image'),
        postedAt: d.postedAt?.toDate ? d.postedAt.toDate().toISOString() : null,
        mediaId: d.mediaId || null,
        lastError: d.lastError || null,
      };
    });

    return res.json({ success: true, posts });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch scheduled posts.');
  }
}

module.exports = {
  schedulePost,
  getScheduledPosts,
};
