const { getDb, getAdmin } = require('../utils/firestoreAdmin');
const { isIndexMissingError, logIndexRequirement } = require('../utils/firestoreIndexGuard');

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

function isValidUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
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

function parseTimeString(value) {
  const raw = String(value || '').trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]), raw: `${match[1].padStart(2, '0')}:${match[2]}` };
}

function normalizeDays(value) {
  if (!Array.isArray(value)) return [];
  const unique = [...new Set(value.map((v) => Number(v)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return unique.sort((a, b) => a - b);
}

function resolveNextSlotDate({ days, time }) {
  const parsed = parseTimeString(time);
  if (!parsed) return null;
  const now = new Date();
  for (let i = 0; i <= 14; i += 1) {
    const dt = new Date(now);
    dt.setDate(now.getDate() + i);
    dt.setSeconds(0, 0);
    dt.setHours(parsed.hour, parsed.minute, 0, 0);
    if (dt <= now) continue;
    if (days.includes(dt.getDay())) return dt;
  }
  return null;
}

function normalizeImageUrls(req) {
  const urls = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : [];
  const cleaned = urls.map((u) => String(u || '').trim()).filter(Boolean);
  const single = String(req.body?.imageUrl || req.body?.mediaUrl || '').trim();
  if (cleaned.length > 0) return cleaned;
  return single ? [single] : [];
}

async function createSlot(req, res) {
  const userId = getUserId(req);
  const days = normalizeDays(req.body?.days);
  const time = String(req.body?.time || '').trim();
  const timezone = String(req.body?.timezone || 'UTC').trim();
  const active = req.body?.active !== false;
  if (!userId || days.length === 0 || !parseTimeString(time)) {
    return res.status(400).json({
      success: false,
      error: { message: 'userId, days, and time (HH:mm) are required.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    const admin = getAdmin();
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!db || !serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = await db.collection('posting_slots').add({
      userId,
      days,
      time,
      timezone,
      active,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return res.status(201).json({ success: true, id: ref.id });
  } catch (error) {
    return sendError(res, error, 'Failed to create slot.');
  }
}

async function getSlots(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    if (!db) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const snap = await db.collection('posting_slots').where('userId', '==', userId).get();
    const slots = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    return res.json({ success: true, slots });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch slots.');
  }
}

async function updateSlot(req, res) {
  const userId = getUserId(req);
  const slotId = String(req.params?.slotId || '').trim();
  if (!userId || !slotId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or slotId.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    const admin = getAdmin();
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!db || !serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = db.collection('posting_slots').doc(slotId);
    const snap = await ref.get();
    if (!snap.exists || String((snap.data() || {}).userId || '') !== userId) {
      return res.status(404).json({ success: false, error: { message: 'Slot not found.', code: 'NOT_FOUND' } });
    }
    const updates = { updatedAt: serverTimestamp() };
    if (req.body?.days) updates.days = normalizeDays(req.body.days);
    if (req.body?.time && parseTimeString(req.body.time)) updates.time = String(req.body.time).trim();
    if (typeof req.body?.timezone === 'string') updates.timezone = req.body.timezone.trim();
    if (typeof req.body?.active === 'boolean') updates.active = req.body.active;
    await ref.set(updates, { merge: true });
    return res.json({ success: true, id: slotId });
  } catch (error) {
    return sendError(res, error, 'Failed to update slot.');
  }
}

async function deleteSlot(req, res) {
  const userId = getUserId(req);
  const slotId = String(req.params?.slotId || '').trim();
  if (!userId || !slotId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or slotId.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    if (!db) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = db.collection('posting_slots').doc(slotId);
    const snap = await ref.get();
    if (!snap.exists || String((snap.data() || {}).userId || '') !== userId) {
      return res.status(404).json({ success: false, error: { message: 'Slot not found.', code: 'NOT_FOUND' } });
    }
    await ref.delete();
    return res.json({ success: true, id: slotId });
  } catch (error) {
    return sendError(res, error, 'Failed to delete slot.');
  }
}

async function schedulePost(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId (or x-user-uid header).', code: 'VALIDATION_ERROR' },
    });
  }

  const imageUrls = normalizeImageUrls(req);
  const imageUrl = imageUrls[0] || '';
  const caption = String(req.body?.caption || '').trim();
  const mediaType = String(req.body?.mediaType || 'image').toLowerCase();
  const scheduledAt = parseDate(req.body?.scheduledAt);

  if (imageUrls.length === 0) {
    return res.status(400).json({
      success: false,
      error: { message: 'imageUrl or imageUrls is required.', code: 'VALIDATION_ERROR' },
    });
  }
  if (imageUrls.some((url) => !isValidUrl(url))) {
    return res.status(400).json({
      success: false,
      error: { message: 'imageUrl must be a public https URL.', code: 'VALIDATION_ERROR' },
    });
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
      imageUrls,
      caption,
      scheduledAt,
      mode: 'exact',
      queueSlotId: null,
      status: 'pending',
      mediaType: mediaType === 'video' || mediaType === 'reel' ? 'video' : 'image',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      mediaId: null,
      postedAt: null,
      lastError: null,
      retryCount: Number(req.body?.retryCount || 0),
      lastRetryAt: null,
    };

    console.log('📅 Scheduled Post Data:', {
      userId,
      imageUrl,
      imageUrls,
      caption,
      scheduledAt: scheduledAt.toISOString(),
      mediaType: payload.mediaType,
    });

    const ref = await db.collection('scheduled_posts').add(payload);
    console.log(`[Scheduler] Scheduled post created: ${ref.id} (userId=${userId})`);
    return res.status(201).json({
      success: true,
      id: ref.id,
      data: {
        userId: payload.userId,
        imageUrl: payload.imageUrl,
        imageUrls: payload.imageUrls,
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

async function scheduleQueuePost(req, res) {
  const userId = getUserId(req);
  const queueSlotId = String(req.body?.queueSlotId || '').trim();
  if (!userId || !queueSlotId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or queueSlotId.', code: 'VALIDATION_ERROR' },
    });
  }
  const imageUrls = normalizeImageUrls(req);
  const imageUrl = imageUrls[0] || '';
  const caption = String(req.body?.caption || '').trim();
  const mediaType = String(req.body?.mediaType || 'image').toLowerCase();
  if (!imageUrl || !caption) {
    return res.status(400).json({
      success: false,
      error: { message: 'imageUrl/imageUrls and caption are required.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    const admin = getAdmin();
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!db || !serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const slotSnap = await db.collection('posting_slots').doc(queueSlotId).get();
    const slot = slotSnap.data() || {};
    if (!slotSnap.exists || String(slot.userId || '') !== userId || slot.active === false) {
      return res.status(404).json({ success: false, error: { message: 'Queue slot not found.', code: 'NOT_FOUND' } });
    }
    const scheduledAt = resolveNextSlotDate({
      days: normalizeDays(slot.days),
      time: String(slot.time || ''),
    });
    if (!scheduledAt) {
      return res.status(400).json({
        success: false,
        error: { message: 'Unable to resolve next queue slot time.', code: 'QUEUE_RESOLVE_ERROR' },
      });
    }

    const ref = await db.collection('scheduled_posts').add({
      userId,
      imageUrl,
      imageUrls,
      caption,
      scheduledAt,
      mode: 'queue',
      queueSlotId,
      status: 'pending',
      mediaType: mediaType === 'video' || mediaType === 'reel' ? 'video' : 'image',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      mediaId: null,
      postedAt: null,
      lastError: null,
      retryCount: 0,
      lastRetryAt: null,
    });
    return res.status(201).json({ success: true, id: ref.id, scheduledAt: scheduledAt.toISOString() });
  } catch (error) {
    return sendError(res, error, 'Failed to schedule queue post.');
  }
}

async function retryFailedPost(req, res) {
  const userId = getUserId(req);
  const postId = String(req.params?.postId || '').trim();
  if (!userId || !postId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or postId.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    const admin = getAdmin();
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!db || !serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = db.collection('scheduled_posts').doc(postId);
    const snap = await ref.get();
    if (!snap.exists || String((snap.data() || {}).userId || '') !== userId) {
      return res.status(404).json({ success: false, error: { message: 'Post not found.', code: 'NOT_FOUND' } });
    }
    const prev = snap.data() || {};
    if (String(prev.status || '') !== 'failed') {
      return res.status(400).json({
        success: false,
        error: { message: 'Only failed posts can be retried.', code: 'INVALID_STATUS' },
      });
    }
    const retryCount = Number(prev.retryCount || 0);
    const rescheduleAt = new Date(Date.now() + 3 * 60 * 1000);
    await ref.set(
      {
        status: 'pending',
        retryCount: retryCount + 1,
        lastRetryAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        scheduledAt: rescheduleAt,
        lastError: null,
        lastErrorCode: null,
      },
      { merge: true }
    );
    console.log(`[Scheduler] Manual retry postId=${postId} nextRun=${rescheduleAt.toISOString()}`);
    return res.json({ success: true, id: postId, scheduledAt: rescheduleAt.toISOString() });
  } catch (error) {
    return sendError(res, error, 'Failed to retry post.');
  }
}

async function updateScheduledPost(req, res) {
  const userId = getUserId(req);
  const postId = String(req.params?.postId || '').trim();
  if (!userId || !postId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or postId.', code: 'VALIDATION_ERROR' },
    });
  }
  const scheduledAt = parseDate(req.body?.scheduledAt);
  if (req.body?.scheduledAt && !scheduledAt) {
    return res.status(400).json({
      success: false,
      error: { message: 'scheduledAt must be a valid date-time.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    const admin = getAdmin();
    const serverTimestamp = admin?.firestore?.FieldValue?.serverTimestamp;
    if (!db || !serverTimestamp) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = db.collection('scheduled_posts').doc(postId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: { message: 'Post not found.', code: 'NOT_FOUND' } });
    }
    const existing = snap.data() || {};
    if (String(existing.userId || '') !== userId) {
      return res.status(403).json({ success: false, error: { message: 'Forbidden.', code: 'FORBIDDEN' } });
    }
    const updates = { updatedAt: serverTimestamp() };
    if (typeof req.body?.caption === 'string') updates.caption = req.body.caption.trim();
    const imageUrls = normalizeImageUrls(req);
    if (imageUrls.length > 0) {
      updates.imageUrls = imageUrls;
      updates.imageUrl = imageUrls[0];
    }
    if (scheduledAt) updates.scheduledAt = scheduledAt;
    if (typeof req.body?.mediaType === 'string') updates.mediaType = req.body.mediaType === 'video' ? 'video' : 'image';
    await ref.set(updates, { merge: true });
    return res.json({ success: true, id: postId });
  } catch (error) {
    return sendError(res, error, 'Failed to update scheduled post.');
  }
}

async function deleteScheduledPost(req, res) {
  const userId = getUserId(req);
  const postId = String(req.params?.postId || '').trim();
  if (!userId || !postId) {
    return res.status(400).json({
      success: false,
      error: { message: 'Missing userId or postId.', code: 'VALIDATION_ERROR' },
    });
  }
  try {
    const db = getDb();
    if (!db) {
      return res.status(500).json({
        success: false,
        error: { message: 'Firestore unavailable.', code: 'FIRESTORE_UNAVAILABLE' },
      });
    }
    const ref = db.collection('scheduled_posts').doc(postId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: { message: 'Post not found.', code: 'NOT_FOUND' } });
    }
    const existing = snap.data() || {};
    if (String(existing.userId || '') !== userId) {
      return res.status(403).json({ success: false, error: { message: 'Forbidden.', code: 'FORBIDDEN' } });
    }
    await ref.delete();
    return res.json({ success: true, id: postId });
  } catch (error) {
    return sendError(res, error, 'Failed to delete scheduled post.');
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
      let lastError = d.lastError;
      if (lastError && typeof lastError === 'object' && lastError.message != null) {
        lastError = String(lastError.message);
      } else if (lastError != null) {
        lastError = String(lastError);
      } else {
        lastError = null;
      }
      return {
        id: doc.id,
        userId: String(d.userId || ''),
        imageUrl: String(d.imageUrl || ''),
        imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls : d.imageUrl ? [d.imageUrl] : [],
        caption: String(d.caption || ''),
        scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
        status: String(d.status || 'pending'),
        mode: String(d.mode || 'exact'),
        queueSlotId: d.queueSlotId || null,
        createdAt: createdAt ? createdAt.toISOString() : null,
        mediaType: String(d.mediaType || 'image'),
        postedAt: d.postedAt?.toDate ? d.postedAt.toDate().toISOString() : null,
        mediaId: d.mediaId || null,
        lastError,
        lastErrorCode: d.lastErrorCode ? String(d.lastErrorCode) : null,
        retryCount: Number(d.retryCount || 0),
      };
    });

    return res.json({ success: true, posts });
  } catch (error) {
    if (isIndexMissingError(error)) {
      logIndexRequirement({
        queryName: 'scheduler.getScheduledPosts',
        collection: 'scheduled_posts',
        fields: ['userId ASC', 'scheduledAt DESC'],
        error,
      });
      return res.json({
        success: true,
        posts: [],
        warning: 'Firestore index pending. Returning empty scheduled posts list temporarily.',
      });
    }
    return sendError(res, error, 'Failed to fetch scheduled posts.');
  }
}

module.exports = {
  createSlot,
  getSlots,
  updateSlot,
  deleteSlot,
  schedulePost,
  scheduleQueuePost,
  retryFailedPost,
  getScheduledPosts,
  updateScheduledPost,
  deleteScheduledPost,
};
