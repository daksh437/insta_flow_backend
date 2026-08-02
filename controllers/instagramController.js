const { getDb } = require('../utils/firestoreAdmin');
const instagramService = require('../services/instagram_service');
const { createOAuthState } = require('../utils/oauthState');

function getUid(req) {
  return String(
    req.headers['x-user-uid'] ||
      req.headers['X-User-UID'] ||
      req.headers['x-user-id'] ||
      req.query.userId ||
      req.body?.userId ||
      ''
  ).trim();
}

async function getStoredInstagramAuth(uid) {
  const db = getDb();
  if (!db) {
    const err = new Error('Firestore unavailable');
    err.status = 500;
    err.code = 'firestore_unavailable';
    throw err;
  }
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data() || {};
  const instagram = user.instagram || {};
  const token = String(instagram.access_token || '').trim();
  if (!token) {
    const err = new Error('Instagram not connected');
    err.status = 401;
    err.code = 'instagram_not_connected';
    throw err;
  }
  const expiresAt =
    instagram.token_expires_at && typeof instagram.token_expires_at.toDate === 'function'
      ? instagram.token_expires_at.toDate()
      : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    const err = new Error('Instagram token expired. Please reconnect.');
    err.status = 401;
    err.code = 'token_expired';
    throw err;
  }
  return { db, token, instagram };
}

function sendError(res, error) {
  const status = Number(error?.status || 500);
  const code = String(error?.code || 'internal_error');
  const message = String(error?.message || 'Something went wrong');
  return res.status(status).json({ success: false, code, error: message });
}

async function getInstagramStats(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { db, token } = await getStoredInstagramAuth(uid);
    const profile = await instagramService.getUserProfile(token);

    // Aggregate real engagement from recent media (likes + comments are on the
    // media object; no insights scope needed).
    let media = [];
    try {
      media = await instagramService.getRecentMedia(token, 25);
    } catch (e) {
      console.warn('[getInstagramStats] media read failed:', e.message);
    }
    let totalLikes = 0;
    let totalComments = 0;
    let topLikes = 0;
    for (const m of media) {
      const l = Number(m.like_count || 0);
      const c = Number(m.comments_count || 0);
      totalLikes += l;
      totalComments += c;
      if (l > topLikes) topLikes = l;
    }
    const sampled = media.length;
    const followers = Number(profile.followers_count || 0);
    const posts = Number(profile.media_count || sampled || 0);
    const avgLikes = sampled ? Math.round(totalLikes / sampled) : 0;
    const avgComments = sampled ? Math.round(totalComments / sampled) : 0;
    const engagementRate =
      followers > 0 && sampled > 0
        ? Number((((totalLikes + totalComments) / sampled / followers) * 100).toFixed(2))
        : 0;

    const username = String(profile.username || '');
    const accountType = String(profile.account_type || '');
    const now = new Date();

    await db.collection('users').doc(uid).set(
      {
        instagram: {
          connected: true,
          instagram_user_id: String(profile.id || ''),
          username,
          followers_count: followers,
          media_count: posts,
          account_type: accountType,
          last_sync: now,
        },
      },
      { merge: true }
    );

    // Mirror rich stats into instagram_data/profile — the screen reads this.
    await db
      .collection('users')
      .doc(uid)
      .collection('instagram_data')
      .doc('profile')
      .set(
        {
          username,
          account_type: accountType,
          followers_count: followers,
          media_count: posts,
          total_likes: totalLikes,
          total_comments: totalComments,
          avg_likes: avgLikes,
          avg_comments: avgComments,
          top_post_likes: topLikes,
          engagement_rate: engagementRate,
          sampled_posts: sampled,
          updated_at: now,
        },
        { merge: true }
      );

    return res.json({
      success: true,
      followers,
      following: Number(profile.follows_count || 0),
      posts,
      likes: totalLikes,
      comments: totalComments,
      avgLikes,
      avgComments,
      topPostLikes: topLikes,
      engagementRate,
      sampledPosts: sampled,
      username,
      accountType,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function createMedia(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const videoUrl = String(req.body?.videoUrl || '').trim();
    const caption = String(req.body?.caption || '');
    const isReel = req.body?.isReel === true;

    const creationId = await instagramService.createMedia({
      accessToken: token,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
      caption,
      isReel,
    });

    return res.json({
      success: true,
      creationId,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function publishMedia(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const creationId = String(req.body?.creationId || '').trim();
    const published = await instagramService.publishMedia({
      accessToken: token,
      creationId,
    });
    return res.json({ success: true, mediaId: published.id });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getInsights(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  try {
    const { token } = await getStoredInstagramAuth(uid);
    const data = await instagramService.getInsights(token);
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error);
  }
}

async function connectInstagram(req, res) {
  const uid = getUid(req);
  if (!uid) return res.status(401).json({ success: false, code: 'unauthorized', error: 'Missing x-user-uid header' });
  const redirectUri = String(process.env.INSTAGRAM_REDIRECT_URI || '').trim();
  const clientId = String(process.env.INSTAGRAM_APP_ID || '').trim();
  if (!redirectUri || !clientId) {
    return res.status(500).json({
      success: false,
      code: 'instagram_config_missing',
      error: 'INSTAGRAM_APP_ID or INSTAGRAM_REDIRECT_URI not configured',
    });
  }
  const authUrl =
    `https://www.instagram.com/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments' +
    '&response_type=code' +
    `&state=${encodeURIComponent(createOAuthState(uid, 'instagram'))}`;

  return res.json({ success: true, authUrl });
}

// TEMPORARY diagnostic — calls graph.instagram.com/me with the stored token and
// returns the RAW response so we can see the exact error. Gated by a key; never
// returns the token itself. Remove after debugging.
async function debugInstagramProfile(req, res) {
  if (String(req.query.key || '') !== 'studio-debug-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const axios = require('axios');
    const db = getDb();
    if (!db) return res.json({ ok: false, reason: 'db unavailable' });

    // Find the most recently connected user (solo-dev friendly scan).
    const snap = await db.collection('users').limit(300).get();
    let found = null;
    for (const d of snap.docs) {
      const ig = (d.data() || {}).instagram || {};
      if (ig && typeof ig.access_token === 'string' && ig.access_token.trim()) {
        const connectedAt = ig.connected_at && ig.connected_at.toMillis ? ig.connected_at.toMillis() : 0;
        if (!found || connectedAt > found.connectedAt) {
          found = { uid: d.id, token: ig.access_token.trim(), username: ig.username || null, expiresAt: ig.token_expires_at || null, connectedAt };
        }
      }
    }
    if (!found) return res.json({ ok: false, reason: 'no connected user found in Firestore' });

    const meResp = await axios.get('https://graph.instagram.com/me', {
      params: {
        fields: 'user_id,username,account_type,media_count,followers_count,follows_count',
        access_token: found.token,
      },
      validateStatus: () => true,
      timeout: 20000,
    });

    // Also attempt the long-lived token exchange to capture its raw error.
    const secret = String(process.env.INSTAGRAM_APP_SECRET || '');
    const exResp = await axios.get('https://graph.instagram.com/access_token', {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: secret,
        access_token: found.token,
      },
      validateStatus: () => true,
      timeout: 20000,
    });

    return res.json({
      ok: true,
      uid: found.uid,
      storedUsername: found.username,
      tokenLength: found.token.length,
      tokenPrefix: found.token.slice(0, 6),
      me_http: meResp.status,
      me_body: meResp.data,
      exchange_http: exResp.status,
      exchange_body: exResp.data,
    });
  } catch (e) {
    return res.json({ ok: false, error: e?.message || 'debug failed' });
  }
}

module.exports = {
  connectInstagram,
  getInstagramStats,
  createMedia,
  publishMedia,
  getInsights,
  debugInstagramProfile,
};
