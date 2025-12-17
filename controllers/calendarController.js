const { google } = require('googleapis');
const { createOAuthClient } = require('../utils/oauthClient');
const { getTokens, saveTokens } = require('../utils/tokenStore');

function getUserId(req) {
  return req.headers['x-user-uid'] || req.body?.userId || req.query?.userId;
}

async function createCalendarEvent(req, res) {
  const { title, description, startDateTime, endDateTime } = req.body || {};
  const userId = getUserId(req);

  if (!userId) return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID' });
  if (!title || !startDateTime || !endDateTime) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  try {
    const tokens = getTokens(userId);
    if (!tokens) {
      return res.status(401).json({ success: false, error: 'User not connected to Google' });
    }

    const client = createOAuthClient();
    client.setCredentials(tokens);

    client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token || newTokens.access_token) {
        saveTokens(userId, { ...tokens, ...newTokens });
      }
    });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const event = {
      summary: title,
      description,
      start: { dateTime: startDateTime },
      end: { dateTime: endDateTime },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error('createCalendarEvent error', error);
    res.status(500).json({ success: false, error: 'Failed to create calendar event' });
  }
}

module.exports = { createCalendarEvent };

