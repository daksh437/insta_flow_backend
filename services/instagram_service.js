const axios = require('axios');

const GRAPH_BASE = 'https://graph.instagram.com';

function sanitizeToken(value) {
  return String(value || '').trim();
}

function toApiError(message, status = 500, code = 'instagram_api_error') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
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

async function createMedia({ accessToken, imageUrl, videoUrl, caption, isReel }) {
  const token = sanitizeToken(accessToken);
  if (!token) throw toApiError('Missing Instagram access token', 401, 'missing_token');
  if (!imageUrl && !videoUrl) {
    throw toApiError('imageUrl or videoUrl is required', 400, 'invalid_media_input');
  }

  const payload = {
    access_token: token,
    caption: caption || '',
  };

  if (videoUrl) {
    payload.media_type = isReel ? 'REELS' : 'VIDEO';
    payload.video_url = videoUrl;
  } else {
    payload.image_url = imageUrl;
  }

  return graphPost('/me/media', payload);
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
