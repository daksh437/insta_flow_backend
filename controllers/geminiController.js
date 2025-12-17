const { runGemini, runGeminiWithImage } = require('../utils/geminiClient');
const { processImageForGemini } = require('../utils/imageProcessor');

/**
 * Extract JSON from text that may contain markdown wrappers or extra text
 * @param {string} text - Raw text that may contain JSON
 * @returns {object|null} - Parsed JSON object or null if extraction fails
 */
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') {
    console.warn('[extractJsonFromText] Invalid input:', typeof text);
    return null;
  }
  
  try {
    // Step 1: Remove ```json or ``` wrappers
    let cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
    cleaned = cleaned.trim();
    
    // Step 2: Try direct parse first
    try {
      const parsed = JSON.parse(cleaned);
      console.log('[extractJsonFromText] Direct parse successful');
      return parsed;
    } catch (e) {
      console.log('[extractJsonFromText] Direct parse failed, extracting JSON block...');
    }
    
    // Step 3: Extract text between first { and last }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonBlock = cleaned.substring(firstBrace, lastBrace + 1);
      console.log('[extractJsonFromText] Extracted JSON block, length:', jsonBlock.length);
      try {
        const parsed = JSON.parse(jsonBlock);
        console.log('[extractJsonFromText] Successfully parsed extracted JSON block');
        return parsed;
      } catch (e) {
        console.error('[extractJsonFromText] Failed to parse extracted block:', e.message);
        console.error('[extractJsonFromText] Block sample:', jsonBlock.substring(0, 200));
      }
    }
    
    // Step 4: Try to extract JSON array [ ... ]
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const jsonArray = cleaned.substring(firstBracket, lastBracket + 1);
      console.log('[extractJsonFromText] Extracted JSON array, length:', jsonArray.length);
      try {
        const parsed = JSON.parse(jsonArray);
        console.log('[extractJsonFromText] Successfully parsed extracted JSON array');
        return parsed;
      } catch (e) {
        console.error('[extractJsonFromText] Failed to parse extracted array:', e.message);
      }
    }
    
    console.warn('[extractJsonFromText] No valid JSON structure found');
    console.warn('[extractJsonFromText] Text sample:', text.substring(0, 300));
    return null;
  } catch (error) {
    console.error('[extractJsonFromText] Unexpected error:', error.message);
    return null;
  }
}

// Legacy function for backward compatibility
function tryParseJson(text, fallback) {
  const parsed = extractJsonFromText(text);
  return parsed !== null ? parsed : fallback;
}

// FIXED System Prompt - ChatGPT-style role-based
function getSystemPrompt() {
  return `You are an expert Instagram caption writer specialized in creating unique, engaging captions.

STRICT RULES (NO EXCEPTIONS):

1. Language MUST be strictly followed - write captions ONLY in the selected language.
2. Mood MUST strongly affect writing style, tone, words, and emojis.
3. Audience MUST affect intent and CTA completely.
4. Do NOT mix styles - stick to the selected Mood.
5. Never repeat captions or hashtags from past responses.
6. Avoid generic Instagram phrases completely.
7. Every request is UNIQUE - never reuse previous captions.

LANGUAGE GUIDELINES (MANDATORY):

- English → Write captions in pure English only, English hashtags
- Hinglish → Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing"), use both Hindi and English hashtags
- Hindi → Write captions in pure Hindi (Devanagari script), Hindi hashtags, natural Hindi expressions

MOOD GUIDELINES (MANDATORY):

- Funny → playful, light jokes, emojis allowed 😄😂, casual language, humor-focused
- Attitude → bold, confident, short punchlines 💪🔥, assertive tone, power words
- Aesthetic → calm, poetic, minimal words ✨🌙, visual descriptions, serene tone
- Motivational → inspiring, action-driven 🚀💡, encouraging words, goal-oriented
- Romantic → emotional, soft, feeling-based ❤️🌹, heartfelt language, intimate tone

AUDIENCE GUIDELINES (MANDATORY):

- Creator → engagement CTAs (Save this, Share with a friend, Comment below), community-focused
- Business → professional tone, value-focused CTA (Learn more, Visit link, Get started), results-oriented
- Personal → casual, diary-style, no marketing tone, authentic voice, no CTAs

OUTPUT FORMAT:
Return STRICT JSON only:
{
  "captions": [
    {
      "style": "",
      "text": "",
      "hashtags": []
    }
  ]
}`;
}

// User Prompt - Contains only user inputs
function getUserPrompt(topic, tone, audience, language, generationId) {
  return `GENERATION_ID: ${generationId}

THIS IS A COMPLETELY NEW REQUEST.
NEVER reuse captions from previous generations.

Generate 5 UNIQUE Instagram captions under 120 characters.

USER INPUTS:
- Topic: ${topic}
- Language: ${language}
- Mood/Tone: ${tone}
- Audience Type: ${audience}

CRITICAL: The Language "${language}", Mood "${tone}", and Audience "${audience}" MUST be clearly visible in EVERY caption.

Each caption must use a DIFFERENT writing angle but MUST follow the selected Language "${language}", Mood "${tone}", and Audience "${audience}".

Generate 15 relevant hashtags in the selected language (no repetition).

Return STRICT JSON only.`;
}

function calendarPrompt(topic, days) {
  return `You are a professional Instagram strategist.

Create a 7-day content calendar for: "${topic}".

For each day include:

- day_of_week
- content_type (Reel / Carousel / Story / Static Image / Meme)
- hook (strong first line)
- caption (high-quality human-like writing)
- hashtag_set (15 optimized tags)
- best_post_time (IST)
- content_brief (what visuals to create)
- viral_angle (why it will perform well)
- cta (call to action)

Use real IG analytics logic (trends, engagement patterns, niche signals).

Return STRICT JSON array.`;
}

function strategyPrompt(niche) {
  return `You are a senior Instagram growth strategist and analytics expert.

Create a complete growth strategy for the niche "${niche}".

Return JSON with these keys:

{
  "audience_profile": {
    "age_groups": [],
    "psychology": [],
    "pain_points": [],
    "motivations": []
  },
  "growth_plan": {
    "reel_strategy": "",
    "posting_frequency": "",
    "content_style": "",
    "what_to_avoid": ""
  },
  "viral_content_ideas": [
    { "hook": "", "angle": "", "why_it_works": "" }
  ],
  "analytics": {
    "best_times_IST": [],
    "competition_strength": "",
    "content_gap_opportunities": []
  },
  "hashtag_strategy": {
    "low_comp": [],
    "mid_comp": [],
    "high_comp": []
  },
  "cta_strategy": ""
}

Write everything as if you are consulting a real creator.`;
}

function nicheAnalysisPrompt(topic) {
  return `Analyze the Instagram niche "${topic}" and return:

- trend_forecast_30_days: Trend forecast for next 30 days
- top_5_viral_patterns: Top 5 viral content patterns
- best_3_reel_formats: Best 3 reel formats for this niche
- hashtag_clusters: Hashtag clusters based on difficulty (low, mid, high - 10 each)
- untapped_content_ideas: Content ideas that competitors are not using
- psychological_triggers: Engagement boosting psychological triggers
- common_mistakes: Warning: Common mistakes creators make

Return structured JSON.`;
}

function imageAnalysisPrompt() {
  return `You are an expert Instagram content strategist and visual analyst.

Analyze the uploaded image carefully and understand:

- What is happening in the image
- Mood and emotion
- Style (aesthetic, professional, casual, luxury, fitness, travel, etc.)
- Target Instagram audience

Now generate:

1. 5 high-quality Instagram captions (under 150 characters)
2. Each caption must match the image mood
3. Use modern Instagram language
4. Add a subtle CTA (Save / Share / Comment)
5. Generate 15 optimized hashtags based on the image and niche

Return output in STRICT JSON:

{
  "analysis": {
    "mood": "",
    "style": "",
    "scene": ""
  },
  "captions": [
    {
      "text": "",
      "hashtags": []
    }
  ]
}`;
}

// Step 1: Extract basic attributes from image (Vision API - fast analysis only)
function imageAttributeExtractionPrompt() {
  return `Analyze this image and extract ONLY these basic attributes:

- scene: indoor OR outdoor
- setting: travel OR festival OR casual OR work OR home OR event OR other
- mood: calm OR energetic OR confident OR happy OR serious OR playful OR relaxed OR other
- time: day OR night
- occasion: casual OR festival OR travel OR work OR celebration OR event OR other (or "not clearly visible")

Return STRICT JSON only:
{
  "scene": "indoor or outdoor",
  "setting": "one of the options above",
  "mood": "one of the options above",
  "time": "day or night",
  "occasion": "one of the options above or 'not clearly visible'"
}`;
}

// Step 2: Generate captions using text-only model with extracted attributes
function captionGenerationPrompt(scene, setting, mood, time, occasion) {
  const seed = Date.now() + Math.random();
  
  return `VARIATION_SEED: ${seed}

You are an expert Instagram content strategist.

Context from image analysis:
Scene: ${scene}
Setting: ${setting}
Mood: ${mood}
Time: ${time}
Occasion: ${occasion}

Rules:
- No generic captions.
- No repeated captions or hashtags.
- Each caption must be unique and human-like.

Generate 5 captions under 120 characters.
Each caption with a different writing style.

Generate 15 optimized hashtags.

Return STRICT JSON only:

{
  "captions": [
    {
      "angle": "aesthetic",
      "text": "[Caption under 120 chars]",
      "hashtags": ["#tag1", "#tag2", "#tag3"]
    },
    {
      "angle": "confident",
      "text": "[Caption under 120 chars]",
      "hashtags": ["#tag1", "#tag2", "#tag3"]
    },
    {
      "angle": "story-based",
      "text": "[Caption under 120 chars]",
      "hashtags": ["#tag1", "#tag2", "#tag3"]
    },
    {
      "angle": "short punchline",
      "text": "[Caption under 120 chars]",
      "hashtags": ["#tag1", "#tag2", "#tag3"]
    },
    {
      "angle": "emotional",
      "text": "[Caption under 120 chars]",
      "hashtags": ["#tag1", "#tag2", "#tag3"]
    }
  ]
}`;
}

async function generateCaptions(req, res) {
  const { topic, tone, audience, language, regenerate } = req.body || {};
  
  // Validate required parameters - throw error if missing
  if (!topic || topic.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Topic is required',
      data: []
    });
  }
  if (!tone || tone.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Mood/Tone is required',
      data: []
    });
  }
  if (!audience || audience.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Audience is required',
      data: []
    });
  }
  if (!language || language.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Language is required',
      data: []
    });
  }
  
  // Generate UNIQUE generationId for EVERY request (especially for regenerate)
  const generationId = `${Date.now()}-${Math.random()}`;
  
  console.log(`[generateCaptions] Request received - topic: ${topic}, tone: ${tone}, audience: ${audience}, language: ${language}, regenerate: ${regenerate || false}, generationId: ${generationId}`);
  try {
    console.log('[generateCaptions] Using ChatGPT-style role-based prompting...');
    
    // Get system prompt (fixed instructions)
    const systemPrompt = getSystemPrompt();
    
    // Get user prompt (user inputs only)
    const userPrompt = getUserPrompt(topic.trim(), tone.trim(), audience.trim(), language.trim(), generationId);
    
    // Call Gemini with role-based prompting
    const output = await runGemini('', { 
      systemPrompt: systemPrompt,
      userPrompt: userPrompt,
      maxTokens: 1024, 
      temperature: 0.9,
      topP: 0.95
    });
    console.log('[generateCaptions] Gemini response received, length:', output?.length || 0);
    
    // Log raw AI output for debugging
    console.log('[generateCaptions] ===== RAW AI OUTPUT START =====');
    console.log(output);
    console.log('[generateCaptions] ===== RAW AI OUTPUT END =====');
    
    // CRITICAL: Use extractJsonFromText() - do NOT assume Gemini returns pure JSON
    const data = extractJsonFromText(output);
    
    // Validate parsed data
    if (!data || typeof data !== 'object') {
      console.error('[generateCaptions] ERROR: Failed to parse JSON from AI response');
      console.error('[generateCaptions] Raw output sample:', output?.substring(0, 500));
      return res.status(500).json({
        success: false,
        error: 'No captions generated. AI response was invalid.',
        details: 'Failed to parse JSON from AI response. The AI may have returned non-JSON text.',
        data: []
      });
    }
    
    console.log('[generateCaptions] Parsed data structure:', Object.keys(data));
    
    // Support both old format (array) and new format (object with captions array)
    let captions = [];
    if (Array.isArray(data)) {
      // Old format: array of {caption, hashtags}
      console.log('[generateCaptions] Detected old format (array)');
      captions = data.map(item => ({
        style: item.style || 'general',
        text: item.caption || item.text || '',
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : []
      })).filter(item => item.text && item.text.trim().length > 0);
    } else if (data && data.captions && Array.isArray(data.captions)) {
      // New format: {captions: [...]}
      console.log('[generateCaptions] Detected new format (object with captions array)');
      captions = data.captions.map(item => ({
        style: item.style || 'general',
        text: item.text || item.caption || '',
        hashtags: Array.isArray(item.hashtags) ? item.hashtags : []
      })).filter(item => item.text && item.text.trim().length > 0);
    } else if (data && typeof data === 'object') {
      // Try to find captions in any key
      console.log('[generateCaptions] Trying to find captions in object keys:', Object.keys(data));
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          console.log('[generateCaptions] Found array in key:', key);
          captions = data[key].map(item => ({
            style: item.style || 'general',
            text: item.text || item.caption || '',
            hashtags: Array.isArray(item.hashtags) ? item.hashtags : []
          })).filter(item => item.text && item.text.trim().length > 0);
          break;
        }
      }
    }
    
    // CRITICAL: Validate captions array - throw clear error if empty
    if (!Array.isArray(captions) || captions.length === 0) {
      console.error('[generateCaptions] ERROR: No valid captions found in response');
      console.error('[generateCaptions] Parsed data:', JSON.stringify(data, null, 2));
      console.error('[generateCaptions] Captions array length:', captions.length);
      return res.status(500).json({
        success: false,
        error: 'No captions generated. AI response was invalid.',
        details: 'The AI response did not contain a valid captions array, or all captions were empty.',
        data: []
      });
    }
    
    // Ensure backend ALWAYS returns { "captions": [...] } format
    console.log('[generateCaptions] ✅ Sending response with', captions.length, 'captions');
    res.json({ 
      success: true, 
      data: captions 
    });
  } catch (error) {
    console.error('[generateCaptions] ERROR:', error.message);
    console.error('[generateCaptions] ERROR Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate captions', 
      details: error.message,
      data: []
    });
  }
}

async function generateCalendar(req, res) {
  const { topic = 'instagram growth', days = 7 } = req.body || {};
  console.log(`[generateCalendar] Request received - topic: ${topic}, days: ${days}`);
  try {
    console.log('[generateCalendar] Calling Gemini API...');
    const output = await runGemini(calendarPrompt(topic, days), { maxTokens: 4096, temperature: 0.7 });
    console.log('[generateCalendar] Gemini response received');
    const data = tryParseJson(output, []);
    console.log('[generateCalendar] Sending response');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[generateCalendar] ERROR:', error.message);
    console.error('[generateCalendar] ERROR Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate calendar', 
      details: error.message,
      data: []
    });
  }
}

async function generateStrategy(req, res) {
  const { niche = 'instagram growth' } = req.body || {};
  console.log(`[generateStrategy] Request received - niche: ${niche}`);
  try {
    console.log('[generateStrategy] Calling Gemini API...');
    const output = await runGemini(strategyPrompt(niche), { maxTokens: 4096, temperature: 0.7 });
    console.log('[generateStrategy] Gemini response received');
    const data = tryParseJson(output, {});
    console.log('[generateStrategy] Sending response');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[generateStrategy] ERROR:', error.message);
    console.error('[generateStrategy] ERROR Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate strategy', 
      details: error.message,
      data: {}
    });
  }
}

async function analyzeNiche(req, res) {
  const { topic = 'instagram growth' } = req.body || {};
  console.log(`[analyzeNiche] Request received - topic: ${topic}`);
  try {
    console.log('[analyzeNiche] Calling Gemini API...');
    const output = await runGemini(nicheAnalysisPrompt(topic), { maxTokens: 4096, temperature: 0.7 });
    console.log('[analyzeNiche] Gemini response received');
    const data = tryParseJson(output, {});
    console.log('[analyzeNiche] Sending response');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[analyzeNiche] ERROR:', error.message);
    console.error('[analyzeNiche] ERROR Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to analyze niche', 
      details: error.message,
      data: {}
    });
  }
}

async function generateImageCaptions(req, res) {
  const { imageBase64, imageMimeType = 'image/jpeg' } = req.body || {};
  console.log(`[generateImageCaptions] Request received - image size: ${imageBase64?.length || 0} bytes, mimeType: ${imageMimeType}`);
  
  if (!imageBase64) {
    return res.status(400).json({
      success: false,
      error: 'Missing imageBase64 in request body',
      data: null
    });
  }
  
  try {
    console.log('[generateImageCaptions] Calling Gemini Vision API...');
    const prompt = imageAnalysisPrompt();
    const output = await runGeminiWithImage(prompt, imageBase64, imageMimeType, { 
      maxTokens: 2048, 
      temperature: 0.8 
    });
    console.log('[generateImageCaptions] Gemini response received, length:', output?.length || 0);
    const data = tryParseJson(output, { analysis: {}, captions: [] });
    console.log('[generateImageCaptions] Sending response');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[generateImageCaptions] ERROR:', error.message);
    console.error('[generateImageCaptions] ERROR Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to generate image captions', 
      details: error.message,
      data: { analysis: {}, captions: [] }
    });
  }
}

async function generateCaptionFromMedia(req, res) {
  const { imageBase64, imageMimeType = 'image/jpeg' } = req.body || {};
  const imageSizeKB = imageBase64 ? Math.round(imageBase64.length / 1024) : 0;
  console.log(`[generateCaptionFromMedia] Request received - image size: ${imageSizeKB} KB, mimeType: ${imageMimeType}`);
  
  if (!imageBase64) {
    return res.status(400).json({
      success: false,
      error: 'Missing imageBase64 in request body',
      data: null
    });
  }
  
  // Check if image is too large (more than 10MB base64 = ~7.5MB actual)
  if (imageBase64.length > 10 * 1024 * 1024) {
    console.warn(`[generateCaptionFromMedia] Image too large: ${imageSizeKB} KB`);
    return res.status(400).json({
      success: false,
      error: 'Image too large. Please use an image smaller than 10MB.',
      details: 'Images are automatically optimized by the server.',
      data: null
    });
  }
  
  try {
    console.log('[generateCaptionFromMedia] HYBRID APPROACH: Step 1 - Extracting image attributes...');
    const processStartTime = Date.now();
    
    // Step 1: Process image for Vision API (smaller for faster analysis)
    const processedImage = await processImageForGemini(imageBase64, imageMimeType);
    const processDuration = Date.now() - processStartTime;
    console.log(`[generateCaptionFromMedia] ✅ Image processed in ${processDuration}ms: ${processedImage.sizeKB} KB`);
    
    // Step 2: Extract basic attributes using Vision API (fast, minimal analysis)
    console.log('[generateCaptionFromMedia] Step 2 - Calling Gemini Vision for attribute extraction...');
    const attributePrompt = imageAttributeExtractionPrompt();
    const attributeStartTime = Date.now();
    const attributeOutput = await runGeminiWithImage(attributePrompt, processedImage.base64, processedImage.mimeType, { 
      maxTokens: 256, // Small response for attributes only
      temperature: 0.7,
      topP: 0.9
    });
    const attributeDuration = Date.now() - attributeStartTime;
    console.log(`[generateCaptionFromMedia] ✅ Attributes extracted in ${attributeDuration}ms`);
    
    // Parse attributes
    const attributes = tryParseJson(attributeOutput, { 
      scene: 'indoor', 
      setting: 'casual', 
      mood: 'happy', 
      time: 'day', 
      occasion: 'casual' 
    });
    
    const { scene, setting, mood, time, occasion } = attributes;
    console.log(`[generateCaptionFromMedia] Extracted: scene=${scene}, setting=${setting}, mood=${mood}, time=${time}, occasion=${occasion}`);
    
    // Step 3: Generate captions using text-only model (faster, more stable)
    console.log('[generateCaptionFromMedia] Step 3 - Generating captions with text-only Gemini...');
    const captionPrompt = captionGenerationPrompt(scene, setting, mood, time, occasion);
    const captionStartTime = Date.now();
    const captionOutput = await runGemini(captionPrompt, { 
      maxTokens: 1024,
      temperature: 0.8
    });
    const captionDuration = Date.now() - captionStartTime;
    console.log(`[generateCaptionFromMedia] ✅ Captions generated in ${captionDuration}ms`);
    
    // Parse captions
    const captionData = tryParseJson(captionOutput, { captions: [] });
    
    // Combine attributes and captions
    const data = {
      analysis: {
        scene: scene,
        setting: setting,
        mood: mood,
        time: time,
        occasion: occasion
      },
      captions: captionData.captions || []
    };
    
    const totalDuration = Date.now() - processStartTime;
    console.log(`[generateCaptionFromMedia] ✅ Total processing time: ${totalDuration}ms`);
    console.log(`[generateCaptionFromMedia] Generated ${data.captions.length} captions`);
    
    res.json({ success: true, data });
  } catch (error) {
    console.error('[generateCaptionFromMedia] ERROR:', error.message);
    console.error('[generateCaptionFromMedia] ERROR Stack:', error.stack);
    
    // Always return error JSON (never let it crash)
    const errorResponse = {
      success: false,
      error: 'Failed to generate caption from media',
      details: error.message || 'Unknown error',
      data: { analysis: {}, captions: [] }
    };
    
    // Check if timeout error
    if (error.message && error.message.includes('timeout')) {
      errorResponse.error = 'Request timeout - Image processing took too long';
      errorResponse.details = 'Please try again with a smaller image or check your connection';
    }
    
    res.status(500).json(errorResponse);
  }
}

module.exports = {
  generateCaptions,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
};

