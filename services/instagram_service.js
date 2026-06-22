const axios = require('axios');

const GRAPH_BASE = 'https://graph.instagram.com';
const GRAPH_FB_BASE = 'https://graph.facebook.com/v18.0';

function sanitizeToken(value) {
  return String(value || '').trim();
}

function toApiError(message, status = 500, code = 'instagram_api_error') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function isValidUrl(url) {
  const u = String(url || '').trim();
  return (
    u.startsWith('https://') &&
    (u.startsWith('https://firebasestorage.googleapis.com') ||
      u.startsWith('https://storage.googleapis.com'))
  );
}

async function graphGet(path, params = {}) {
  const url = `${GRAPH_BASE}${path}`;
  try {
    const response = await axios.get(url, {
      params,
      timeout: 25000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const apiMessage =
        response.data?.error?.message ||
        response.data?.error_message ||
        `Instagram API request failed (${response.status})`;
      const code = response.status === 400 ? 'invalid_token_or_request' : 'instagram_api_error';
      throw toApiError(apiMessage, response.status, code);
    }
    return response.data;
  } catch (error) {
    if (error.status) throw error;
    throw toApiError(error.message || 'Instagram API unavailable', 502, 'instagram_network_error');
  }
}

async function graphPost(path, body = {}) {
  const url = `${GRAPH_BASE}${path}`;
  try {
    const response = await axios.post(url, new URLSearchParams(body).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 25000,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const apiMessage =
        response.data?.error?.message ||
        response.data?.error_message ||
        `Instagram API request failed (${response.status})`;
      const code = response.status === 400 ? 'invalid_token_or_request' : 'instagram_api_error';
      throw toApiError(apiMessage, response.status, code);
    }
    return response.data;
  } catch (error) {
    if (error.status) throw error;
    throw toApiError(error.message || 'Instagram API unavailable', 502, 'instagram_network_error');
  }
}

async function getUserProfile(accessToken) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  return graphGet('/me', {
    fields: 'id,username,account_type,media_count,followers_count,follows_count',
    access_token: token,
  });
}

async function createMedia({ accessToken, imageUrl, videoUrl, caption, isReel, isCarousel, children, isCarouselItem }) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  const mediaUrl = String(videoUrl || imageUrl || '').trim();
  const childIds = Array.isArray(children) ? children.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (!isCarousel) {
    if (!mediaUrl) {
      throw toApiError('imageUrl or videoUrl is required', 400, 'invalid_media_input');
    }
    if (!isValidUrl(mediaUrl)) {
      throw toApiError('INVALID_IMAGE_URL', 400, 'invalid_media_url');
    }
  } else if (childIds.length < 2) {
    throw toApiError('Carousel requires at least 2 children', 400, 'invalid_media_input');
  }

  try {
    const profile = await getUserProfile(token);
    const igUserId = String(profile?.id || '').trim();
    if (!igUserId) {
      throw toApiError('Instagram user id not found', 400, 'missing_ig_user_id');
    }

    console.log('Image URL:', mediaUrl);
    console.log('Caption:', caption || '');
    console.log('Creating media with:', {
      image_url: mediaUrl,
      caption: caption || '',
      ig_user_id: igUserId,
    });

    const body = { caption: caption || '', access_token: token };
    if (isCarousel) {
      body.media_type = 'CAROUSEL';
      body.children = childIds.join(',');
    } else if (isCarouselItem) {
      body.is_carousel_item = true;
    } else if (videoUrl) {
      body.media_type = isReel ? 'REELS' : 'VIDEO';
      body.video_url = mediaUrl;
    }
    if (!videoUrl && !isCarousel) {
      body.image_url = mediaUrl;
    }

    const res = await axios.post(`${GRAPH_FB_BASE}/${igUserId}/media`, body, {
      timeout: 25000,
    });

    console.log('CREATE MEDIA RESPONSE:', res.data);

    const mediaId = String(res.data?.id || '').trim();
    if (!mediaId) {
      console.error('CREATE MEDIA ERROR: Instagram did not return media ID', res.data);
      throw new Error('Instagram did not return media ID');
    }

    return mediaId;
  } catch (err) {
    console.error('CREATE MEDIA ERROR:', err.response?.data || err.message);
    throw new Error('Media creation failed');
  }
}

async function publishMedia({ accessToken, creationId }) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  if (!creationId) throw toApiError('creationId is required', 400, 'invalid_publish_input');
  return graphPost('/me/media_publish', {
    creation_id: creationId,
    access_token: token,
  });
}

async function getInsights(accessToken) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  const profile = await getUserProfile(token);
  return {
    followers_count: Number(profile.followers_count || 0),
    media_count: Number(profile.media_count || 0),
    follows_count: Number(profile.follows_count || 0),
    username: profile.username || '',
    account_type: profile.account_type || '',
  };
}

/**
 * Recent media for the connected account (real engagement signal).
 * Requires a Business/Creator IG account; like_count/comments_count may be
 * absent on some account types — callers must treat them as optional.
 */
async function getRecentMedia(accessToken, limit = 25) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  const data = await graphGet('/me/media', {
    fields: 'id,caption,media_type,like_count,comments_count,timestamp,permalink',
    limit,
    access_token: token,
  });
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Build a compact "creator context" from the user's REAL account: their
 * best-performing format, the IST hours their top posts were published,
 * hashtags that worked, and themes from their best captions. Used to ground
 * AI generation in what already works for THIS creator. Network-safe: if media
 * can't be read, returns profile-only context (counts may be 0).
 */
async function buildCreatorContext(accessToken) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  const profile = await getUserProfile(token);

  let media = [];
  try {
    media = await getRecentMedia(token, 25);
  } catch (e) {
    console.warn('[buildCreatorContext] media read failed:', e.message);
    media = [];
  }

  const scored = media
    .map((m) => ({
      ...m,
      eng: Number(m.like_count || 0) + Number(m.comments_count || 0),
    }))
    .sort((a, b) => b.eng - a.eng);
  const top = scored.slice(0, 8);

  // Best-performing format by total engagement.
  const formatEng = {};
  for (const m of scored) {
    const t = String(m.media_type || 'IMAGE');
    formatEng[t] = (formatEng[t] || 0) + m.eng;
  }
  const bestFormat = Object.keys(formatEng).sort((a, b) => formatEng[b] - formatEng[a])[0] || null;

  // Audience-active hours (IST = UTC+5:30) inferred from top posts' publish times.
  const hourCount = {};
  for (const m of top) {
    if (!m.timestamp) continue;
    const d = new Date(m.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    const istMinutes = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
    const istHour = Math.floor(istMinutes / 60);
    hourCount[istHour] = (hourCount[istHour] || 0) + 1;
  }
  const bestHoursIST = Object.keys(hourCount)
    .sort((a, b) => hourCount[b] - hourCount[a])
    .slice(0, 3)
    .map(Number);

  // Hashtags that appeared in the best posts.
  const tagCount = {};
  for (const m of top) {
    const tags = String(m.caption || '').match(/#[\wऀ-ॿ]+/g) || [];
    for (const tag of tags) {
      const key = tag.toLowerCase();
      tagCount[key] = (tagCount[key] || 0) + 1;
    }
  }
  const topHashtags = Object.keys(tagCount)
    .sort((a, b) => tagCount[b] - tagCount[a])
    .slice(0, 12);

  // Short theme snippets from the best captions.
  const topThemes = top
    .slice(0, 4)
    .map((m) => String(m.caption || '').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean);

  return {
    followers: Number(profile.followers_count || 0),
    username: profile.username || '',
    accountType: profile.account_type || '',
    sampleCount: media.length,
    bestFormat,
    bestHoursIST,
    topHashtags,
    topThemes,
  };
}

module.exports = {
  getUserProfile,
  createMedia,
  publishMedia,
  getInsights,
  getRecentMedia,
  buildCreatorContext,
};
