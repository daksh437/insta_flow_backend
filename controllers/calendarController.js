const { google } = require('googleapis');
const { createOAuthClient } = require('../utils/oauthClient');
const { getTokens, saveTokens } = require('../utils/tokenStore');

function getUserId(req) {
  // Try multiple header name variations (case-insensitive)
  const uid = req.headers['x-user-uid'] || 
              req.headers['X-User-UID'] || 
              req.headers['x-user-id'] || 
              req.headers['X-User-Id'] ||
              req.body?.userId || 
              req.query?.userId;
  
  // Log for debugging
  if (!uid) {
    console.log('[getUserId] No userId found. Headers:', Object.keys(req.headers).filter(k => k.toLowerCase().includes('user')));
    console.log('[getUserId] Query:', req.query);
    console.log('[getUserId] Body:', req.body);
  }
  
  return uid;
}

async function createCalendarEvent(req, res) {
  try {
    const { title, description, startDateTime, endDateTime } = req.body || {};
    const userId = getUserId(req);

    console.log('[createCalendarEvent] Request received - userId:', userId || 'missing');
    console.log('[createCalendarEvent] Event data:', { title, description, startDateTime, endDateTime });

    if (!userId) {
      console.error('[createCalendarEvent] Missing userId');
      return res.status(400).json({ success: false, error: 'Missing userId/Firebase UID. Please login first.' });
    }
    
    if (!title || !startDateTime || !endDateTime) {
      console.error('[createCalendarEvent] Missing required fields:', { 
        hasTitle: !!title, 
        hasStartDateTime: !!startDateTime, 
        hasEndDateTime: !!endDateTime 
      });
      return res.status(400).json({ 
        success: false, 
        error: `Missing required fields: ${!title ? 'title' : ''} ${!startDateTime ? 'startDateTime' : ''} ${!endDateTime ? 'endDateTime' : ''}`.trim()
      });
    }

    console.log('[createCalendarEvent] Getting tokens for userId:', userId);
    const tokens = getTokens(userId);
    if (!tokens) {
      console.error('[createCalendarEvent] No tokens found for userId:', userId);
      return res.status(401).json({ 
        success: false, 
        error: 'User not connected to Google Calendar. Please connect your Google Calendar first from the settings.' 
      });
    }

    console.log('[createCalendarEvent] Creating OAuth client and setting credentials');
    const client = createOAuthClient();
    client.setCredentials(tokens);

    // Handle token refresh
    client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token || newTokens.access_token) {
        console.log('[createCalendarEvent] Tokens refreshed, saving...');
        saveTokens(userId, { ...tokens, ...newTokens });
      }
    });

    console.log('[createCalendarEvent] Creating calendar event...');
    const calendar = google.calendar({ version: 'v3', auth: client });
    
    // Validate and format datetime
    const startDate = new Date(startDateTime);
    const endDate = new Date(endDateTime);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      console.error('[createCalendarEvent] Invalid date format:', { startDateTime, endDateTime });
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid date format. Please use ISO 8601 format (e.g., 2024-01-01T10:00:00Z)' 
      });
    }

    const event = {
      summary: title,
      description: description || 'Scheduled via InstaFlow',
      start: { 
        dateTime: startDate.toISOString(),
        timeZone: 'UTC',
      },
      end: { 
        dateTime: endDate.toISOString(),
        timeZone: 'UTC',
      },
    };

    console.log('[createCalendarEvent] Event object:', JSON.stringify(event, null, 2));

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });

    console.log('[createCalendarEvent] ✅ Event created successfully:', response.data.id);
    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error('[createCalendarEvent] ❌ Error:', error.message);
    console.error('[createCalendarEvent] Stack:', error.stack);
    
    // Provide more specific error messages
    let errorMessage = 'Failed to create calendar event';
    if (error.message.includes('invalid_grant')) {
      errorMessage = 'Google Calendar access expired. Please reconnect your Google Calendar.';
    } else if (error.message.includes('insufficient')) {
      errorMessage = 'Insufficient permissions. Please ensure calendar access is granted.';
    } else if (error.message.includes('invalid')) {
      errorMessage = `Invalid request: ${error.message}`;
    } else {
      errorMessage = `Failed to create calendar event: ${error.message}`;
    }
    
    res.status(500).json({ success: false, error: errorMessage });
  }
}

module.exports = { createCalendarEvent };

