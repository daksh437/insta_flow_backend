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

module.exports = {
  getUserProfile,
  createMedia,
  publishMedia,
  getInsights,
};
