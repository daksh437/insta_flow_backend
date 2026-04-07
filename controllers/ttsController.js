const axios = require('axios');

const DEFAULT_LANGUAGE = 'en-IN';
const DEFAULT_VOICE = 'en-IN-Neural2-A';
const HINDI_VOICE = 'hi-IN-Neural2-A';

function resolveVoice(languageCode) {
  const lang = (languageCode || DEFAULT_LANGUAGE).toLowerCase();
  if (lang.startsWith('hi')) return HINDI_VOICE;
  return DEFAULT_VOICE;
}

async function synthesizeTts(req, res) {
  const text = String(req.body?.text || '').trim();
  const languageCode = String(req.body?.languageCode || DEFAULT_LANGUAGE).trim();
  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_TTS_API_KEY || '';

  if (!text) {
    return res.status(400).json({ error: 'Text is required' });
  }

  if (!apiKey) {
    console.error('[TTS] Missing GOOGLE_TTS_API_KEY');
    return res.status(500).json({ error: 'TTS unavailable' });
  }

  const requestPayload = {
    input: { text },
    voice: {
      languageCode,
      name: resolveVoice(languageCode),
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0,
    },
  };

  try {
    console.log(`[TTS] request textLen=${text.length} lang=${languageCode}`);
    const response = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      requestPayload,
      {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const audioContent = response.data?.audioContent;
    if (!audioContent || typeof audioContent !== 'string') {
      console.error('[TTS] success=false reason=missing_audioContent');
      return res.status(502).json({ error: 'TTS unavailable' });
    }

    console.log(`[TTS] success textLen=${text.length} lang=${languageCode}`);
    return res.json({ audioContent });
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    console.error('[TTS] failed', { status, detail });
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: 'TTS unavailable',
    });
  }
}

module.exports = {
  synthesizeTts,
};
