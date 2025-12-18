const { runGemini, runGeminiWithImage } = require('../utils/geminiClient');
const { processImageForGemini } = require('../utils/imageProcessor');
const { v4: uuidv4 } = require('uuid');
const { createJob, updateJob, generateJobId } = require('../utils/jobStore');

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

/**
 * Extract captions from plain text response (when JSON parsing fails)
 * Treats Gemini output as RAW TEXT and extracts captions using robust logic
 * @param {string} text - Raw text from Gemini
 * @param {string} language - Language for fallback captions
 * @returns {Array<string>} - Array of caption strings (5-7 captions)
 */
function extractCaptionsFromText(text, language = 'English') {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.log('[extractCaptionsFromText] Empty or invalid text input');
    return [];
  }

  console.log('[extractCaptionsFromText] Extracting captions from plain text, length:', text.length);
  
  // Step 1: Split by newlines
  let lines = text.split(/\r?\n/);
  console.log('[extractCaptionsFromText] Split into', lines.length, 'lines');
  
  // Step 2: Clean and filter lines
  const captions = [];
  for (let line of lines) {
    // Remove leading/trailing whitespace
    line = line.trim();
    
    // Skip empty lines
    if (!line || line.length === 0) continue;
    
    // Remove numbering patterns: "1.", "2.", "-", "•", "*", etc.
    line = line.replace(/^[\d]+[\.\)]\s*/, ''); // "1. ", "2) "
    line = line.replace(/^[-•*]\s*/, ''); // "- ", "• ", "* "
    line = line.replace(/^[\u2022\u2023\u25E6\u2043]\s*/, ''); // Unicode bullet points
    line = line.trim();
    
    // Skip if line is too short (likely not a caption) or too long (likely not a caption)
    if (line.length < 10 || line.length > 200) continue;
    
    // Skip lines that look like JSON structure markers
    if (line.match(/^[\[\{\}\]]+$/)) continue;
    if (line.includes('"caption"') || line.includes('"text"') || line.includes('"style"')) continue;
    
    // Skip lines that are just hashtags
    if (line.match(/^#[\w]+(\s+#[\w]+)*$/)) continue;
    
    // Remove trailing hashtags (we'll add them separately if needed)
    // But keep the caption text
    const hashtagMatch = line.match(/(.+?)(\s+#[\w]+(\s+#[\w]+)*)$/);
    if (hashtagMatch) {
      line = hashtagMatch[1].trim();
    }
    
    // Remove common prefixes
    line = line.replace(/^(Caption|Text|Style):\s*/i, '');
    line = line.trim();
    
    // If line still has content, add it
    if (line.length >= 10 && line.length <= 200) {
      captions.push(line);
    }
  }
  
  console.log('[extractCaptionsFromText] Extracted', captions.length, 'captions from text');
  
  // Step 3: Limit to 5-7 captions
  const finalCaptions = captions.slice(0, 7);
  console.log('[extractCaptionsFromText] Final captions count:', finalCaptions.length);
  
  return finalCaptions;
}

/**
 * Get fallback captions when Gemini fails or returns empty response
 * @param {string} language - Language for fallback captions
 * @returns {Array<Object>} - Array of caption objects with style, text, hashtags
 */
function getFallbackCaptions(language = 'English') {
  console.log('[getFallbackCaptions] Using fallback captions for language:', language);
  
  if (language === 'Hindi') {
    return [
      { style: 'motivational', text: 'हर दिन एक नई शुरुआत है।', hashtags: ['#motivation', '#hindi', '#inspiration'] },
      { style: 'aesthetic', text: 'सुंदरता आपके अंदर है।', hashtags: ['#aesthetic', '#beauty', '#hindi'] },
      { style: 'confident', text: 'आप जो चाहें वो कर सकते हैं।', hashtags: ['#confidence', '#power', '#hindi'] },
      { style: 'emotional', text: 'भावनाएं हमें इंसान बनाती हैं।', hashtags: ['#emotions', '#feelings', '#hindi'] },
      { style: 'story', text: 'हर कहानी में एक सबक है।', hashtags: ['#story', '#life', '#hindi'] },
    ];
  } else if (language === 'Hinglish') {
    return [
      { style: 'motivational', text: 'Progress over perfection. आगे बढ़ते रहो!', hashtags: ['#motivation', '#progress', '#hinglish'] },
      { style: 'confident', text: 'Strong body, stronger mindset. 💪', hashtags: ['#fitness', '#mindset', '#hinglish'] },
      { style: 'aesthetic', text: 'Beauty is in the details. ✨', hashtags: ['#aesthetic', '#beauty', '#hinglish'] },
      { style: 'emotional', text: 'Feelings matter. भावनाएं ज़रूरी हैं।', hashtags: ['#feelings', '#emotions', '#hinglish'] },
      { style: 'story', text: 'Every story has a lesson. हर कहानी में सीख है।', hashtags: ['#story', '#life', '#hinglish'] },
    ];
  } else {
    // English (default)
    return [
      { style: 'motivational', text: 'Progress over perfection.', hashtags: ['#motivation', '#progress', '#growth'] },
      { style: 'fitness', text: 'Fitness is a lifestyle, not a phase.', hashtags: ['#fitness', '#lifestyle', '#health'] },
      { style: 'mindset', text: 'Strong body, stronger mindset.', hashtags: ['#mindset', '#strength', '#power'] },
      { style: 'aesthetic', text: 'Beauty is in the details.', hashtags: ['#aesthetic', '#beauty', '#details'] },
      { style: 'inspirational', text: 'Every day is a fresh start.', hashtags: ['#inspiration', '#newday', '#freshstart'] },
    ];
  }
}

// FIXED System Prompt - ChatGPT-style role-based with STRICT uniqueness enforcement
function getSystemPrompt() {
  return `You are an expert Instagram caption writer specialized in creating unique, engaging captions that NEVER repeat - just like ChatGPT generates unique responses every time.

CRITICAL UNIQUENESS RULES (MANDATORY - NO EXCEPTIONS):

1. EVERY caption generation is COMPLETELY NEW - treat each request as if it's the first time you've ever seen this topic.
2. NEVER reuse captions, phrases, words, or hashtags from ANY previous response - even if the same topic is requested.
3. Generate fresh, non-repetitive, creative Instagram captions that feel AI-generated, dynamic, and ChatGPT-like.
4. STRICTLY AVOID generic phrases like "Living my best life", "Good vibes only", "Making memories", "Sunshine and good times", "Vibes", "Mood", "Feeling blessed", "Another day", "Here we go", "Just vibing", "Can't relate", "Same energy", "No cap", "Period", "That's it", "That's the tweet", "Say less", "Facts", "Big mood".
5. Each caption must be unique in wording, tone, structure, sentence length, and hashtags - NO template-based responses.
6. If the same topic is requested again, generate COMPLETELY different captions with different angles, words, emojis, and hashtags - as if ChatGPT is generating a fresh response.
7. Use creative variations, different angles, unique expressions, and fresh perspectives every single time - think like ChatGPT's dynamic generation.
8. The creative seed in each request ensures uniqueness - use it to generate varied outputs that feel random and creative.
9. Think like ChatGPT - every response is unique, creative, context-aware, and never repeats previous outputs.
10. NEVER use the same sentence structure, word choice, emoji pattern, or hashtag combination twice - even across different requests.
11. Generate 5-7 captions (not exactly 5, vary the count) with DIFFERENT writing styles - ensure variety in length, structure, and approach.
12. Each caption must feel like it was written by a different person or at a different time - maximum diversity.

LANGUAGE ENFORCEMENT (STRICT):

- English → Write captions in pure English only, English hashtags, no Hindi/other languages
- Hinglish → Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing"), use both Hindi and English hashtags
- Hindi → Write captions in pure Hindi (Devanagari script), Hindi hashtags, natural Hindi expressions, NO English

MOOD ENFORCEMENT (STRICT - MUST AFFECT EVERY WORD):

- Funny → playful, light jokes, emojis allowed 😄😂, casual language, humor-focused, witty, entertaining
- Attitude → bold, confident, short punchlines 💪🔥, assertive tone, power words, unapologetic, strong
- Aesthetic → calm, poetic, minimal words ✨🌙, visual descriptions, serene tone, dreamy, artistic
- Motivational → inspiring, action-driven 🚀💡, encouraging words, goal-oriented, empowering, uplifting
- Romantic → emotional, soft, feeling-based ❤️🌹, heartfelt language, intimate tone, tender, passionate

AUDIENCE ENFORCEMENT (STRICT - MUST AFFECT CTA AND TONE):

- Creator → engagement CTAs (Save this, Share with a friend, Comment below), community-focused, interactive
- Business → professional tone, value-focused CTA (Learn more, Visit link, Get started), results-oriented, authoritative
- Personal → casual, diary-style, no marketing tone, authentic voice, no CTAs, genuine, relatable

STYLE VARIATION REQUIREMENTS:

Generate 5-7 captions with DIFFERENT writing styles:
1. Story-based / Narrative
2. Question / Curiosity hook
3. Bold statement / Assertion
4. Emotional / Feeling-focused
5. Action-oriented / Call-to-action
6. Aesthetic / Visual description
7. Short punchline / One-liner

OUTPUT FORMAT:
Return STRICT JSON only:
{
  "captions": [
    {
      "style": "unique style name",
      "text": "unique caption text under 120 characters",
      "hashtags": ["unique", "hashtags", "no", "repetition"]
    }
  ]
}`;
}

// User Prompt - Contains user inputs + unique creative seed + requestId
function getUserPrompt(topic, tone, audience, language, generationId, creativeSeed, requestId, regenerate) {
  const regenerateWarning = regenerate 
    ? `\n\n🚨🚨🚨🚨🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨🚨🚨🚨🚨\n\nTHIS IS CRITICAL: The user explicitly wants COMPLETELY DIFFERENT captions from the previous generation.\n\nYou MUST generate captions that are 100% DIFFERENT in:\n- Every single word and phrase (NO reuse)\n- Sentence structure and length (completely different patterns)\n- Hashtags (ZERO repetition from previous set - use completely new hashtags)\n- Writing style and angle (different approach entirely)\n- Emoji usage (different emojis, different placement)\n- Overall tone and approach (fresh perspective)\n- Story angle (if previous was story-based, use different angle)\n\nThink of this as ChatGPT generating a COMPLETELY FRESH response to the same question.\nThe creative seed ${creativeSeed} ensures this output is unique.\n\nDO NOT reuse ANYTHING from previous generation - treat this as a brand new request.\n\n`
    : '';
  
  return `🎲 CREATIVE_SEED: ${creativeSeed}
🆔 REQUEST_ID: ${generationId}
📅 TIMESTAMP: ${Date.now()}
🔄 REQUEST_ID_FROM_CLIENT: ${requestId || 'none'}
🎯 UNIQUENESS_ENFORCEMENT: MAXIMUM (ChatGPT-like behavior)
${regenerateWarning}
⚠️⚠️⚠️⚠️⚠️ THIS IS A COMPLETELY NEW REQUEST - GENERATE FRESH, UNIQUE CAPTIONS ⚠️⚠️⚠️⚠️⚠️

CRITICAL UNIQUENESS INSTRUCTIONS (MANDATORY - NO EXCEPTIONS):

1. UNIQUE CREATIVE SEED: ${creativeSeed}
   - This seed is UNIQUE to this request and ensures different output every time
   - Use this seed to generate varied, creative, non-repetitive captions
   - Think like ChatGPT - every response is unique based on context and seed

2. UNIQUE REQUEST ID: ${requestId || generationId}
   - This ID ensures this generation is COMPLETELY DIFFERENT from any previous generation
   - Even if topic/mood/audience/language are identical, output MUST be different
   - This is like ChatGPT generating a fresh response to the same question

3. NEVER REUSE POLICY (STRICT):
   - NEVER reuse captions, phrases, words, hashtags, or sentence structures from previous generations
   - NEVER use the same sentence structure, word choice, emoji pattern, or hashtag combination twice
   - Even if the topic is the same, generate COMPLETELY DIFFERENT captions
   - Think like ChatGPT generating a fresh response every time

4. GENERATE FRESH, NON-REPETITIVE, CREATIVE CAPTIONS:
   - Avoid generic phrases like "Living my best life", "Good vibes only", "Making memories"
   - Avoid "Sunshine and good times", "Vibes", "Mood", "Feeling blessed", "Another day"
   - Use creative, original, human-like expressions that feel AI-generated and dynamic
   - Each caption must feel like it was written by a different person or at a different time

5. UNIQUE IN EVERY WAY:
   - Each caption must be unique in wording, tone, structure, and hashtags
   - NO template-based responses - every caption must feel fresh and original
   - Maximum diversity in length, structure, and approach

Generate 5-7 UNIQUE Instagram captions under 120 characters.
Each caption MUST be completely different from any previous generation.
Think like ChatGPT - every response is unique, creative, and context-aware.

USER INPUTS (MANDATORY - MUST BE STRICTLY FOLLOWED):
- Topic: "${topic}"
- Language: "${language}" (STRICT - write ONLY in this language, no mixing unless Hinglish)
- Mood/Tone: "${tone}" (STRICT - this mood MUST be visible in every word, emoji, and sentence structure)
- Audience Type: "${audience}" (STRICT - this audience MUST affect CTA, tone, and intent completely)

CRITICAL ENFORCEMENT (NO EXCEPTIONS):
1. Language "${language}" MUST be strictly followed:
   - English → Pure English only, English hashtags, no Hindi/other languages
   - Hinglish → Natural mix of Hindi and English (e.g., "Kya baat hai! This is amazing"), both Hindi and English hashtags
   - Hindi → Pure Hindi (Devanagari script), Hindi hashtags, natural Hindi expressions, NO English

2. Mood "${tone}" MUST strongly affect EVERY aspect:
   - Writing style, tone, words, emojis, sentence structure, and overall vibe
   - If Funny → Must be playful, light, humorous, entertaining
   - If Attitude → Must be bold, confident, assertive, unapologetic
   - If Aesthetic → Must be calm, poetic, minimal, dreamy, artistic
   - If Motivational → Must be inspiring, action-driven, empowering, uplifting
   - If Romantic → Must be emotional, soft, heartfelt, intimate, tender

3. Audience "${audience}" MUST affect intent and CTA completely:
   - Creator → Engagement CTAs (Save this, Share with a friend, Comment below), community-focused, interactive
   - Business → Professional tone, value-focused CTA (Learn more, Visit link, Get started), results-oriented, authoritative
   - Personal → Casual, diary-style, no marketing tone, authentic voice, no CTAs, genuine, relatable

4. Generate 5-7 captions with DIFFERENT writing styles:
   - Story-based / Narrative (tell a story)
   - Question / Curiosity hook (ask engaging questions)
   - Bold statement / Assertion (make strong statements)
   - Emotional / Feeling-focused (express feelings)
   - Action-oriented / Call-to-action (encourage action)
   - Aesthetic / Visual description (describe visuals)
   - Short punchline / One-liner (quick, witty)

5. Generate 15 unique hashtags in the selected language:
   - NO repetition within this response
   - NO reuse from previous generations
   - Mix of niche-specific, trending, and evergreen tags

6. Avoid generic Instagram phrases completely:
   - NO "Living my best life", "Good vibes only", "Making memories", "Sunshine and good times"
   - NO "Vibes", "Mood", "Feeling blessed", "Another day", "Here we go"
   - Use creative, original, human-like expressions

7. Each caption must feel fresh, original, and AI-generated (like ChatGPT):
   - Dynamic, context-aware, and unique
   - No template-based responses
   - Creative and engaging

Return STRICT JSON only with unique captions:
{
  "captions": [
    {
      "style": "unique style name",
      "text": "unique caption text under 120 characters",
      "hashtags": ["unique", "hashtags", "no", "repetition"]
    }
  ]
}`;
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

/**
 * Background processing function for captions generation
 * Runs Gemini API call asynchronously and updates job status
 */
async function processCaptions(jobId, topic, tone, audience, language, regenerate, requestId) {
  console.log(`[processCaptions] Starting background processing for job: ${jobId}`);
  
  try {
    // Generate UNIQUE generationId for EVERY request
    const finalRequestId = requestId || `BACKEND-${Date.now()}-${Math.random()}-${topic.trim().substring(0, 10)}-${regenerate ? 'REGEN' : 'NEW'}`;
    const generationId = `${Date.now()}-${Math.random()}-${regenerate ? 'REGEN' : 'NEW'}-${Math.random().toString(36).substring(2, 15)}`;
    const creativeSeed = `${uuidv4()}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 10)}-${finalRequestId.substring(0, 20)}`;
    
    const systemPrompt = getSystemPrompt();
    const userPrompt = getUserPrompt(topic.trim(), tone.trim(), audience.trim(), language.trim(), generationId, creativeSeed, finalRequestId, regenerate);
    
    let output = '';
    try {
      output = await runGemini(userPrompt, { 
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        maxTokens: 1500,
        temperature: 0.95,
        topP: 0.98
      });
    } catch (geminiError) {
      console.error('[processCaptions] Gemini API call failed:', geminiError.message);
      output = '';
    }
    
    // Extract captions from plain text
    let captions = [];
    if (output && typeof output === 'string' && output.trim().length > 0) {
      const textCaptions = extractCaptionsFromText(output, language);
      if (textCaptions && textCaptions.length > 0) {
        captions = textCaptions.map((text, index) => ({
          style: ['story', 'question', 'bold', 'emotional', 'action', 'aesthetic', 'punchline'][index % 7] || 'general',
          text: text,
          hashtags: []
        }));
      }
    }
    
    // Use fallback if empty
    if (captions.length === 0) {
      captions = getFallbackCaptions(language);
    }
    
    // Update job with completed status
    updateJob(jobId, 'done', { data: captions });
    console.log(`[processCaptions] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processCaptions] Error processing job ${jobId}:`, error);
    // Store fallback result instead of error
    const fallbackCaptions = getFallbackCaptions(language);
    updateJob(jobId, 'done', { data: fallbackCaptions, error: error.message });
  }
}

/**
 * POST /ai/captions
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */

/**
 * POST /ai/captions
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function generateCaptions(req, res) {
  const { topic, tone, audience, language, regenerate, requestId } = req.body || {};
  
  // Validate required parameters
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: [] });
  }
  if (!tone || tone.trim() === '') {
    return res.status(400).json({ success: false, error: 'Mood/Tone is required', data: [] });
  }
  if (!audience || audience.trim() === '') {
    return res.status(400).json({ success: false, error: 'Audience is required', data: [] });
  }
  if (!language || language.trim() === '') {
    return res.status(400).json({ success: false, error: 'Language is required', data: [] });
  }
  
  // Generate unique job ID
  const jobId = generateJobId('CAPTIONS');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'captions',
    topic: topic.trim(),
    tone: tone.trim(),
    audience: audience.trim(),
    language: language.trim(),
    regenerate,
  });
  
  console.log(`[generateCaptions] ===== NEW ASYNC REQUEST =====`);
  console.log(`[generateCaptions] Job ID: ${jobId}`);
  console.log(`[generateCaptions] Topic: ${topic}, Tone: ${tone}, Audience: ${audience}, Language: ${language}`);
  
  // Start background processing (non-blocking)
  processCaptions(jobId, topic, tone, audience, language, regenerate, requestId)
    .catch((error) => {
      console.error(`[generateCaptions] Background processing failed for job ${jobId}:`, error);
      // On failure, store fallback result instead of error (per requirements)
      const fallbackCaptions = getFallbackCaptions(language);
      updateJob(jobId, 'done', { 
        data: fallbackCaptions,
        error: error.message || 'AI generation failed'
      });
    });
  
  // Return immediately with jobId (NON-BLOCKING)
  console.log(`[generateCaptions] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing function for calendar generation
 * Runs Gemini API call asynchronously and updates job status
 */
async function processCalendar(jobId, topic, days) {
  console.log(`[processCalendar] Starting background processing for job: ${jobId}`);
  
  try {
    console.log('[processCalendar] Calling Gemini API...');
    const output = await runGemini(calendarPrompt(topic, days), { maxTokens: 4096, temperature: 0.7 });
    console.log('[processCalendar] Gemini response received');
    
    let data = tryParseJson(output, []);
    
    // Ensure data is always an array (fallback if empty)
    if (!Array.isArray(data) || data.length === 0) {
      console.warn('[processCalendar] WARNING: No calendar data extracted, using empty array fallback');
      data = [];
    }
    
    // Update job with completed status
    updateJob(jobId, 'done', { data });
    console.log(`[processCalendar] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processCalendar] Error processing job ${jobId}:`, error);
    // Store fallback result instead of error (empty array)
    updateJob(jobId, 'done', { data: [], error: error.message || 'AI generation failed' });
  }
}

/**
 * POST /ai/calendar
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function generateCalendar(req, res) {
  const { topic = 'instagram growth', days = 7 } = req.body || {};
  
  // Generate unique job ID
  const jobId = generateJobId('CALENDAR');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'calendar',
    topic: topic.trim(),
    days,
  });
  
  console.log(`[generateCalendar] ===== NEW ASYNC REQUEST =====`);
  console.log(`[generateCalendar] Job ID: ${jobId}`);
  console.log(`[generateCalendar] Topic: ${topic}, Days: ${days}`);
  
  // Start background processing (non-blocking)
  processCalendar(jobId, topic.trim(), days)
    .catch((error) => {
      console.error(`[generateCalendar] Background processing failed for job ${jobId}:`, error);
      // On failure, store fallback result
      updateJob(jobId, 'done', { 
        data: [],
        error: error.message || 'AI generation failed'
      });
    });
  
  // Return immediately with jobId (NON-BLOCKING)
  console.log(`[generateCalendar] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing function for strategy generation
 * Runs Gemini API call asynchronously and updates job status
 */
async function processStrategy(jobId, niche) {
  console.log(`[processStrategy] Starting background processing for job: ${jobId}`);
  
  try {
    console.log('[processStrategy] Calling Gemini API...');
    const output = await runGemini(strategyPrompt(niche), { maxTokens: 4096, temperature: 0.7 });
    console.log('[processStrategy] Gemini response received');
    
    let data = tryParseJson(output, {});
    
    // Ensure data is always an object (fallback if empty)
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      console.warn('[processStrategy] WARNING: No strategy data extracted, using empty object fallback');
      data = {};
    }
    
    // Update job with completed status
    updateJob(jobId, 'done', { data });
    console.log(`[processStrategy] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processStrategy] Error processing job ${jobId}:`, error);
    // Store fallback result instead of error (empty object)
    updateJob(jobId, 'done', { data: {}, error: error.message || 'AI generation failed' });
  }
}

/**
 * POST /ai/strategy
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function generateStrategy(req, res) {
  const { niche = 'instagram growth' } = req.body || {};
  
  // Generate unique job ID
  const jobId = generateJobId('STRATEGY');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'strategy',
    niche: niche.trim(),
  });
  
  console.log(`[generateStrategy] ===== NEW ASYNC REQUEST =====`);
  console.log(`[generateStrategy] Job ID: ${jobId}`);
  console.log(`[generateStrategy] Niche: ${niche}`);
  
  // Start background processing (non-blocking)
  processStrategy(jobId, niche.trim())
    .catch((error) => {
      console.error(`[generateStrategy] Background processing failed for job ${jobId}:`, error);
      // On failure, store fallback result
      updateJob(jobId, 'done', { 
        data: {},
        error: error.message || 'AI generation failed'
      });
    });
  
  // Return immediately with jobId (NON-BLOCKING)
  console.log(`[generateStrategy] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing function for niche analysis
 * Runs Gemini API call asynchronously and updates job status
 */
async function processNicheAnalysis(jobId, topic) {
  console.log(`[processNicheAnalysis] Starting background processing for job: ${jobId}`);
  
  try {
    console.log('[processNicheAnalysis] Calling Gemini API...');
    const output = await runGemini(nicheAnalysisPrompt(topic), { maxTokens: 4096, temperature: 0.7 });
    console.log('[processNicheAnalysis] Gemini response received');
    
    let data = tryParseJson(output, {});
    
    // Ensure data is always an object (fallback if empty)
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      console.warn('[processNicheAnalysis] WARNING: No analysis data extracted, using empty object fallback');
      data = {};
    }
    
    // Update job with done status
    updateJob(jobId, 'done', { data });
    console.log(`[processNicheAnalysis] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processNicheAnalysis] Error processing job ${jobId}:`, error);
    // Store fallback result instead of error (empty object)
    updateJob(jobId, 'done', { data: {}, error: error.message || 'AI generation failed' });
  }
}

/**
 * POST /ai/analyze
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function analyzeNiche(req, res) {
  const { topic = 'instagram growth' } = req.body || {};
  
  // Generate unique job ID
  const jobId = generateJobId('ANALYZE');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'analyze',
    topic: topic.trim(),
  });
  
  console.log(`[analyzeNiche] ===== NEW ASYNC REQUEST =====`);
  console.log(`[analyzeNiche] Job ID: ${jobId}`);
  console.log(`[analyzeNiche] Topic: ${topic}`);
  
  // Start background processing (non-blocking)
  processNicheAnalysis(jobId, topic.trim())
    .catch((error) => {
      console.error(`[analyzeNiche] Background processing failed for job ${jobId}:`, error);
      // On failure, store fallback result
      updateJob(jobId, 'done', { 
        data: {},
        error: error.message || 'AI generation failed'
      });
    });
  
  // Return immediately with jobId (NON-BLOCKING)
  console.log(`[analyzeNiche] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
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

/**
 * Get fallback reel script when Gemini fails or returns empty response
 * @param {string} language - Language for fallback script
 * @param {string} topic - Topic for context
 * @param {string} duration - Duration (7s, 10s, 15s, 30s, 60s)
 * @returns {Object} - Fallback reel script object
 */
function getFallbackReelsScript(language = 'English', topic = 'motivation', duration = '15s') {
  console.log('[getFallbackReelsScript] Using fallback script for language:', language);
  
  const baseScript = {
    hooks: [
      language === 'Hindi' ? 'क्या आप भी यह गलती करते हैं?' : 
      language === 'Hinglish' ? 'Kya aap bhi yeh mistake karte ho?' : 
      'Are you making this mistake?',
      language === 'Hindi' ? 'यह बदलाव आपकी जिंदगी बदल देगा' : 
      language === 'Hinglish' ? 'Yeh change aapki life badal dega' : 
      'This change will transform your life',
      language === 'Hindi' ? 'इस तरह से शुरू करें' : 
      language === 'Hinglish' ? 'Is tarah se start karein' : 
      'Start like this today'
    ],
    script: [
      {
        scene: 'Hook',
        duration: '0-3s',
        shot: 'Close-up selfie',
        voiceover: language === 'Hindi' ? 'क्या आप जानते हैं?' : 
                  language === 'Hinglish' ? 'Kya aap jaante hain?' : 
                  'Did you know this?',
        on_screen_text: language === 'Hindi' ? 'यह गलती मत करो' : 
                       language === 'Hinglish' ? 'Yeh galti mat karo' : 
                       'Don\'t make this mistake'
      },
      {
        scene: 'Setup',
        duration: '3-7s',
        shot: 'Medium shot',
        voiceover: language === 'Hindi' ? 'ज्यादातर लोग यह करते हैं' : 
                  language === 'Hinglish' ? 'Zyada tar log yeh karte hain' : 
                  'Most people do this',
        on_screen_text: language === 'Hindi' ? 'लेकिन यह गलत है' : 
                       language === 'Hinglish' ? 'Lekin yeh galat hai' : 
                       'But this is wrong'
      },
      {
        scene: 'Problem',
        duration: '7-10s',
        shot: 'Wide shot',
        voiceover: language === 'Hindi' ? 'इससे आपको नुकसान होता है' : 
                  language === 'Hinglish' ? 'Isse aapko nuksan hota hai' : 
                  'This hurts you',
        on_screen_text: language === 'Hindi' ? 'समस्या यह है' : 
                       language === 'Hinglish' ? 'Samasya yeh hai' : 
                       'The problem is'
      },
      {
        scene: 'Solution',
        duration: '10-13s',
        shot: 'Close-up',
        voiceover: language === 'Hindi' ? 'इस तरह से करें' : 
                  language === 'Hinglish' ? 'Is tarah se karein' : 
                  'Do it like this',
        on_screen_text: language === 'Hindi' ? 'यह सही तरीका है' : 
                       language === 'Hinglish' ? 'Yeh sahi tarika hai' : 
                       'This is the right way'
      },
      {
        scene: 'CTA',
        duration: '13-15s',
        shot: 'Selfie',
        voiceover: language === 'Hindi' ? 'आज से शुरू करें' : 
                  language === 'Hinglish' ? 'Aaj se start karein' : 
                  'Start today',
        on_screen_text: language === 'Hindi' ? 'अभी करें' : 
                       language === 'Hinglish' ? 'Abhi karein' : 
                       'Do it now'
      }
    ],
    cta: language === 'Hindi' ? 'इस पोस्ट को सेव करें और शेयर करें' : 
         language === 'Hinglish' ? 'Is post ko save karein aur share karein' : 
         'Save this post and share with a friend',
    caption: language === 'Hindi' ? 'यह बदलाव आपकी जिंदगी बदल देगा। सेव करें और शेयर करें!' : 
            language === 'Hinglish' ? 'Yeh change aapki life badal dega. Save karein aur share karein!' : 
            'This change will transform your life. Save and share!',
    hashtags: language === 'Hindi' ? ['#reels', '#motivation', '#hindi', '#growth', '#success'] : 
              language === 'Hinglish' ? ['#reels', '#motivation', '#hinglish', '#growth', '#success'] : 
              ['#reels', '#motivation', '#growth', '#success', '#instagram']
  };
  
  return baseScript;
}

/**
 * Extract reel script from plain text response (when JSON parsing fails)
 * @param {string} text - Raw text from Gemini
 * @param {string} language - Language for context
 * @returns {Object|null} - Parsed script object or null
 */
function extractReelsScriptFromText(text, language = 'English') {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.log('[extractReelsScriptFromText] Empty or invalid text input');
    return null;
  }

  console.log('[extractReelsScriptFromText] Extracting script from plain text, length:', text.length);
  
  try {
    // Try to find structured sections
    const hooksMatch = text.match(/(?:hooks?|hook):?\s*\[?([^\]]+)\]?/i);
    const scriptMatch = text.match(/(?:script|scenes?):?\s*\[?([^\]]+)\]?/i);
    
    // Try to extract scene-by-scene data
    const scenes = [];
    const scenePattern = /(?:scene|Scene)\s*(\d+)?[:\-]?\s*([^\n]+)/gi;
    let sceneMatch;
    let sceneIndex = 0;
    
    while ((sceneMatch = scenePattern.exec(text)) !== null && sceneIndex < 6) {
      const sceneText = sceneMatch[2] || sceneMatch[0];
      scenes.push({
        scene: `Scene ${sceneIndex + 1}`,
        duration: `${sceneIndex * 3}-${(sceneIndex + 1) * 3}s`,
        shot: 'Medium shot',
        voiceover: sceneText.substring(0, 100),
        on_screen_text: sceneText.substring(0, 50)
      });
      sceneIndex++;
    }
    
    // If we found at least 3 scenes, construct a basic script
    if (scenes.length >= 3) {
      return {
        hooks: [
          language === 'Hindi' ? 'यह देखें' : language === 'Hinglish' ? 'Yeh dekho' : 'Watch this',
          language === 'Hindi' ? 'जरूर देखें' : language === 'Hinglish' ? 'Zaroor dekho' : 'Must watch',
          language === 'Hindi' ? 'यह महत्वपूर्ण है' : language === 'Hinglish' ? 'Yeh important hai' : 'This is important'
        ],
        script: scenes,
        cta: language === 'Hindi' ? 'सेव करें' : language === 'Hinglish' ? 'Save karein' : 'Save this',
        caption: text.substring(0, 150),
        hashtags: ['#reels', '#instagram', '#viral']
      };
    }
    
    return null;
  } catch (error) {
    console.error('[extractReelsScriptFromText] Error extracting script:', error.message);
    return null;
  }
}

/**
 * Generate reels script prompt
 * @param {string} topic - Topic for the reel
 * @param {string} duration - Duration (7s, 10s, 15s, 30s, 60s)
 * @param {string} tone - Tone (Funny, Motivational, Attitude, Emotional, Aesthetic)
 * @param {string} audience - Audience (Creator, Business, Personal)
 * @param {string} language - Language (English, Hinglish, Hindi)
 * @param {string} generationId - Unique generation ID
 * @param {string} creativeSeed - Creative seed for uniqueness
 * @param {boolean} regenerate - Whether this is a regenerate request
 * @returns {string} - Formatted prompt
 */
function reelsScriptPrompt(topic, duration, tone, audience, language, generationId, creativeSeed, regenerate) {
  const regenerateWarning = regenerate 
    ? `\n\n🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨\nThis means the user wants COMPLETELY DIFFERENT script from the previous generation.\nYou MUST generate a script that is 100% different in:\n- Hook angle and approach\n- Scene structure and flow\n- Voiceover text and style\n- On-screen text\n- Overall storytelling approach\nThink of this as ChatGPT generating a fresh response to the same question.\n\n`
    : '';

  const languageGuidelines = language === 'Hindi' 
    ? 'STRICT: Write EVERYTHING in pure Hindi (Devanagari script). No English words. Hindi hashtags only.'
    : language === 'Hinglish'
    ? 'STRICT: Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing"). Use both Hindi and English hashtags.'
    : 'STRICT: Write EVERYTHING in pure English. English hashtags only.';

  const toneGuidelines = {
    'Funny': 'Playful, light jokes, emojis allowed 😄😂, casual language, humor-focused, witty, entertaining',
    'Motivational': 'Inspiring, action-driven 🚀💡, encouraging words, goal-oriented, empowering, uplifting',
    'Attitude': 'Bold, confident, short punchlines 💪🔥, assertive tone, power words, unapologetic, strong',
    'Emotional': 'Heartfelt, feeling-based ❤️🌹, emotional language, intimate tone, tender, passionate',
    'Aesthetic': 'Calm, poetic, minimal words ✨🌙, visual descriptions, serene tone, dreamy, artistic'
  };

  const audienceGuidelines = {
    'Creator': 'Engagement-focused CTAs (Save this, Share with a friend, Comment below), community-focused, interactive',
    'Business': 'Professional tone, value-focused CTA (Learn more, Visit link, Get started), results-oriented, authoritative',
    'Personal': 'Casual, diary-style, no marketing tone, authentic voice, no CTAs, genuine, relatable'
  };

  return `You are an expert Instagram Reels script writer. Create a professional, viral-ready Reels script.

🎲 CREATIVE_SEED: ${creativeSeed}
🆔 REQUEST_ID: ${generationId}
📅 TIMESTAMP: ${Date.now()}
${regenerateWarning}

CRITICAL RULES (MANDATORY):
1. EVERY response MUST be unique - never reuse hooks, scenes, or text from previous generations
2. Hook-first approach - first 3 seconds must STOP SCROLLING
3. Scene-wise storytelling - break down into 4-6 clear scenes
4. Creator-friendly format - easy to shoot and edit
5. ChatGPT-like creative output - fresh, dynamic, context-aware

USER INPUTS (STRICT):
- Topic: "${topic}"
- Duration: "${duration}"
- Tone: "${tone}" → ${toneGuidelines[tone] || 'Professional and engaging'}
- Audience: "${audience}" → ${audienceGuidelines[audience] || 'General audience'}
- Language: "${language}" → ${languageGuidelines}

DURATION BREAKDOWN:
- ${duration} total duration
- Hook: 0-3s (MUST be scroll-stopping)
- Scene 1: 3-${Math.floor(parseInt(duration) * 0.3)}s
- Scene 2: ${Math.floor(parseInt(duration) * 0.3)}-${Math.floor(parseInt(duration) * 0.6)}s
- Scene 3: ${Math.floor(parseInt(duration) * 0.6)}-${Math.floor(parseInt(duration) * 0.8)}s
- Scene 4: ${Math.floor(parseInt(duration) * 0.8)}-${duration}s
- CTA: Last 2-3 seconds

OUTPUT FORMAT (STRICT JSON):
{
  "hooks": [
    "Hook 1 (scroll-stopping)",
    "Hook 2 (alternative)",
    "Hook 3 (alternative)"
  ],
  "script": [
    {
      "scene": "Hook",
      "duration": "0-3s",
      "shot": "Close-up selfie",
      "voiceover": "Voiceover text (${tone} tone, ${language} language)",
      "on_screen_text": "Short punchy text"
    },
    {
      "scene": "Setup",
      "duration": "3-7s",
      "shot": "Medium shot",
      "voiceover": "Voiceover text",
      "on_screen_text": "On-screen text"
    },
    {
      "scene": "Problem/Story",
      "duration": "7-10s",
      "shot": "Wide shot",
      "voiceover": "Voiceover text",
      "on_screen_text": "On-screen text"
    },
    {
      "scene": "Solution/Value",
      "duration": "10-13s",
      "shot": "Close-up",
      "voiceover": "Voiceover text",
      "on_screen_text": "On-screen text"
    },
    {
      "scene": "CTA",
      "duration": "13-${duration}",
      "shot": "Selfie",
      "voiceover": "Voiceover text",
      "on_screen_text": "Call to action"
    }
  ],
  "cta": "Call to action text (${audience} audience, ${language} language)",
  "caption": "Short reel caption (under 150 chars, ${tone} tone, ${language} language)",
  "hashtags": ["#reels", "#${topic.toLowerCase().replace(/\s+/g, '')}", "#viral", "#instagram", "#${tone.toLowerCase()}"]
}

CRITICAL:
- Generate EXACTLY 3 hooks (all scroll-stopping)
- Generate 4-6 scenes (based on ${duration} duration)
- Each scene MUST have: scene name, duration, shot type, voiceover, on_screen_text
- Language "${language}" MUST be strictly followed
- Tone "${tone}" MUST be visible in every word
- Audience "${audience}" MUST affect CTA and overall approach
- NEVER reuse content from previous generations
- Return STRICT JSON only (no markdown, no extra text)`;
}


/**
 * Background processing function for reels script (handles errors with fallback)
 * Wraps the main processing logic to ensure fallback on any error
 */
async function processReelsScript(jobId, topic, duration, tone, audience, language, regenerate) {
  try {
    // Main processing logic (moved inline to avoid duplicate function)
    console.log(`[processReelsScript] Starting background processing for job: ${jobId}`);
    
    // Generate UNIQUE generationId for EVERY request (especially for regenerate)
    const finalRequestId = `REELS-${Date.now()}-${Math.random()}-${topic.trim().substring(0, Math.min(topic.trim().length, 10))}-${regenerate ? 'REGEN' : 'NEW'}`;
    const generationId = `${Date.now()}-${Math.random()}-${regenerate ? 'REGEN' : 'NEW'}-${Math.random().toString(36).substring(2, 15)}`;
    
    // Generate UNIQUE creative seed
    const creativeSeed = `${uuidv4()}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 10)}-${finalRequestId.substring(0, Math.min(finalRequestId.length, 20))}`;
    
    console.log(`[processReelsScript] Topic: ${topic}, Duration: ${duration}, Tone: ${tone}, Audience: ${audience}, Language: ${language}`);
    console.log(`[processReelsScript] Regenerate: ${regenerate ? 'YES' : 'NO'}`);
    
    let output = '';
    try {
      console.log('[processReelsScript] Calling Gemini API...');
      const prompt = reelsScriptPrompt(topic.trim(), duration, tone.trim(), audience.trim(), language.trim(), generationId, creativeSeed, regenerate);
      
      output = await runGemini(prompt, {
        maxTokens: 2048,
        temperature: 0.9,
        topP: 0.95
      });
    } catch (geminiError) {
      console.error('[processReelsScript] Gemini API call failed:', geminiError.message);
      // On error, use fallback script
      output = '';
    }
    
    console.log('[processReelsScript] Gemini response received, length:', output?.length || 0);
    
    // CRITICAL: Treat Gemini output as PLAIN TEXT ONLY - NEVER expect JSON
    let scriptData = null;
    
    // Step 1: Try JSON parsing first (in case Gemini returns JSON)
    if (output && output.length > 0) {
      scriptData = extractJsonFromText(output);
    }
    
    // Step 2: If JSON parsing failed, extract from plain text
    if (!scriptData || typeof scriptData !== 'object' || !scriptData.hooks || !scriptData.script) {
      console.log('[processReelsScript] JSON parsing failed or incomplete, extracting from plain text...');
      const textScript = extractReelsScriptFromText(output, language);
      
      if (textScript && textScript.hooks && textScript.script) {
        console.log('[processReelsScript] Extracted script from plain text');
        scriptData = textScript;
      }
    }
    
    // Step 3: If still empty, use fallback script (NEVER return empty data)
    if (!scriptData || !scriptData.hooks || !scriptData.script || !Array.isArray(scriptData.hooks) || !Array.isArray(scriptData.script)) {
      console.warn('[processReelsScript] WARNING: No script extracted, using fallback script');
      scriptData = getFallbackReelsScript(language, topic, duration);
    }
    
    // CRITICAL: Final validation - ensure we NEVER return empty data
    if (!scriptData || !scriptData.hooks || !scriptData.script || scriptData.hooks.length === 0 || scriptData.script.length === 0) {
      console.error('[processReelsScript] CRITICAL ERROR: Even fallback script is empty!');
      scriptData = getFallbackReelsScript('English', topic, duration);
    }
    
    // Ensure hooks array has at least 3 items
    if (!Array.isArray(scriptData.hooks) || scriptData.hooks.length < 3) {
      const fallbackHooks = getFallbackReelsScript(language, topic, duration).hooks;
      scriptData.hooks = [...(scriptData.hooks || []), ...fallbackHooks].slice(0, 3);
    }
    
    // Ensure script array has at least 4 items
    if (!Array.isArray(scriptData.script) || scriptData.script.length < 4) {
      const fallbackScript = getFallbackReelsScript(language, topic, duration).script;
      scriptData.script = [...(scriptData.script || []), ...fallbackScript].slice(0, 6);
    }
    
    console.log('[processReelsScript] Final script - hooks:', scriptData.hooks?.length || 0, 'scenes:', scriptData.script?.length || 0);
    
    // Transform to required format
    const transformedData = transformScriptData(scriptData, language, topic, duration);
    
    // Update job with done status and data
    updateJob(jobId, 'done', { data: transformedData });
    console.log(`[processReelsScript] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processReelsScript] Error processing job ${jobId}:`, error);
    // Store fallback result instead of error (per requirements)
    const fallbackScript = getFallbackReelsScript(language, topic, duration);
    const transformedFallback = transformScriptData(fallbackScript, language, topic, duration);
    updateJob(jobId, 'done', { 
      data: transformedFallback,
      error: error.message || 'AI generation failed'
    });
  }
}

/**
 * Transform script data to required format
 * Converts hooks array to single hook, combines voiceovers, ensures 10 hashtags
 */
function transformScriptData(scriptData, language, topic, duration) {
  // Get first hook (or combine if needed)
  const hook = Array.isArray(scriptData.hooks) && scriptData.hooks.length > 0
    ? scriptData.hooks[0]
    : (language === 'Hindi' ? 'क्या आप जानते हैं?' : 
       language === 'Hinglish' ? 'Kya aap jaante hain?' : 
       'Did you know this?');
  
  // Extract scenes
  const scenes = Array.isArray(scriptData.script) ? scriptData.script : [];
  
  // Combine all voiceovers into single string
  const voiceover = scenes
    .map(scene => scene.voiceover || '')
    .filter(v => v && v.trim().length > 0)
    .join(' ');
  
  // Get CTA
  const cta = scriptData.cta || (language === 'Hindi' ? 'इस पोस्ट को सेव करें' : 
                                 language === 'Hinglish' ? 'Is post ko save karein' : 
                                 'Save this post');
  
  // Get caption
  const caption = scriptData.caption || (language === 'Hindi' ? 'यह बदलाव आपकी जिंदगी बदल देगा' : 
                                         language === 'Hinglish' ? 'Yeh change aapki life badal dega' : 
                                         'This change will transform your life');
  
  // Ensure exactly 10 hashtags
  let hashtags = Array.isArray(scriptData.hashtags) ? [...scriptData.hashtags] : [];
  const topicTag = `#${topic.toLowerCase().replace(/\s+/g, '')}`;
  const defaultTags = language === 'Hindi' 
    ? ['#reels', '#viral', '#instagram', '#hindi', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore']
    : language === 'Hinglish'
    ? ['#reels', '#viral', '#instagram', '#hinglish', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore']
    : ['#reels', '#viral', '#instagram', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore', '#content'];
  
  // Combine and ensure exactly 10
  hashtags = [...new Set([...hashtags, topicTag, ...defaultTags])].slice(0, 10);
  
  return {
    hook,
    scenes,
    voiceover: voiceover || (language === 'Hindi' ? 'क्या आप जानते हैं?' : 
                            language === 'Hinglish' ? 'Kya aap jaante hain?' : 
                            'Did you know this?'),
    cta,
    caption,
    hashtags
  };
}

/**
 * Reels script prompt optimized for Gemini 1.5 Flash
 * Returns strict JSON: { hook, scene_by_scene: [{ time, visual, dialogue }], cta, caption, hashtags[] }
 */
function createReelsScriptPrompt(topic, duration, tone, audience, language) {
  // Calculate scene count based on duration
  const durationSeconds = parseInt(duration) || 15;
  const sceneCount = durationSeconds <= 15 ? 4 : durationSeconds <= 30 ? 6 : 8;
  
  const languageRule = language === 'Hindi' 
    ? 'Write EVERYTHING in pure Hindi (Devanagari). No English.'
    : language === 'Hinglish'
    ? 'Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing").'
    : 'Write EVERYTHING in pure English.';
  
  const toneStyle = {
    'Funny': 'Playful, humorous, light jokes 😄',
    'Motivational': 'Inspiring, action-driven, empowering 🚀',
    'Attitude': 'Bold, confident, short punchlines 💪',
    'Emotional': 'Heartfelt, feeling-based, intimate ❤️',
    'Aesthetic': 'Calm, poetic, minimal, dreamy ✨'
  }[tone] || 'Engaging and professional';
  
  return `Create an Instagram Reels script for topic: "${topic}".

Duration: ${duration} (${sceneCount} scenes)
Tone: ${tone} → ${toneStyle}
Audience: ${audience}
Language: ${languageRule}

REQUIREMENTS:
- Hook: One scroll-stopping hook line (short, punchy)
- Scene-by-scene: Exactly ${sceneCount} scenes with time, visual description, and dialogue
- CTA: One call-to-action line
- Caption: Short caption under 150 chars
- Hashtags: Exactly 10 relevant hashtags

OUTPUT FORMAT (STRICT JSON only):
{
  "hook": "Scroll-stopping hook line",
  "scene_by_scene": [
    {
      "time": "0-3s",
      "visual": "What viewer sees (shot description)",
      "dialogue": "What is said (voiceover/text)"
    }
  ],
  "cta": "Call to action",
  "caption": "Short caption",
  "hashtags": ["#tag1", "#tag2", ...]
}

Return ONLY valid JSON, no markdown, no extra text.`;
}

/**
 * Generate fallback reels script (always available)
 * Format: { hook, scene_by_scene: [{ time, visual, dialogue }], cta, caption, hashtags[] }
 */
function getSimpleFallbackScript(language, topic, duration) {
  const durationSeconds = parseInt(duration) || 15;
  const sceneCount = durationSeconds <= 15 ? 4 : durationSeconds <= 30 ? 6 : 8;
  
  const sceneByScene = [];
  for (let i = 0; i < sceneCount; i++) {
    const startTime = i * Math.floor(durationSeconds / sceneCount);
    const endTime = (i + 1) * Math.floor(durationSeconds / sceneCount);
    
    sceneByScene.push({
      time: `${startTime}-${endTime}s`,
      visual: language === 'Hindi' ? 'कैमरा शॉट' : 
             language === 'Hinglish' ? 'Camera shot' : 
             'Medium shot',
      dialogue: language === 'Hindi' ? 'यह महत्वपूर्ण है' : 
                language === 'Hinglish' ? 'Yeh important hai' : 
                'This is important'
    });
  }
  
  return {
    hook: language === 'Hindi' ? 'क्या आप जानते हैं?' : 
          language === 'Hinglish' ? 'Kya aap jaante hain?' : 
          'Did you know this?',
    scene_by_scene: sceneByScene,
    cta: language === 'Hindi' ? 'सेव करें' : 
         language === 'Hinglish' ? 'Save karein' : 
         'Save this post',
    caption: language === 'Hindi' ? 'यह बदलाव आपकी जिंदगी बदल देगा' : 
            language === 'Hinglish' ? 'Yeh change aapki life badal dega' : 
            'This change will transform your life',
    hashtags: language === 'Hindi' 
      ? ['#reels', '#viral', '#hindi', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore', '#instagram']
      : language === 'Hinglish'
      ? ['#reels', '#viral', '#hinglish', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore', '#instagram']
      : ['#reels', '#viral', '#instagram', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore', '#content']
  };
}

/**
 * POST /ai/reels-script
 * Stable synchronous endpoint - one request = one response
 * Timeout <= 25 seconds, never returns 500, always returns fallback on failure
 */
async function generateReelsScript(req, res) {
  const { topic, duration = '15s', tone = 'Motivational', audience = 'Creator', language = 'English' } = req.body || {};
  
  // Validate required parameters
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: {} });
  }
  
  // Validate duration (15s, 30s, 60s only)
  const validDurations = ['15s', '30s', '60s'];
  const finalDuration = validDurations.includes(duration) ? duration : '15s';
  
  console.log(`[generateReelsScript] Request: topic="${topic}", duration=${finalDuration}, tone=${tone}, audience=${audience}, language=${language}`);
  
  // Create timeout promise (25 seconds max - CRITICAL)
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('TIMEOUT_25S'));
    }, 25000);
  });
  
  // Create Gemini API promise
  const geminiPromise = (async () => {
    try {
      const prompt = createReelsScriptPrompt(topic.trim(), finalDuration, tone.trim(), audience.trim(), language.trim());
      
      const output = await runGemini(prompt, {
        maxTokens: 600, // Optimized for speed
        temperature: 0.8,
        topP: 0.95
      });
      
      // Try to parse JSON from response
      let scriptData = null;
      if (output && output.trim().length > 0) {
        scriptData = extractJsonFromText(output);
      }
      
      // Validate structure matches required format
      if (scriptData && 
          typeof scriptData === 'object' &&
          scriptData.hook &&
          Array.isArray(scriptData.scene_by_scene) &&
          scriptData.scene_by_scene.length > 0 &&
          scriptData.cta &&
          scriptData.caption &&
          Array.isArray(scriptData.hashtags)) {
        
        // Validate scene structure
        const validScenes = scriptData.scene_by_scene.every(scene => 
          scene.time && scene.visual && scene.dialogue
        );
        
        if (validScenes) {
          // Ensure exactly 10 hashtags
          if (scriptData.hashtags.length !== 10) {
            const defaultTags = ['#reels', '#viral', '#instagram', '#growth', '#success', '#motivation', '#trending', '#fyp', '#explore', '#content'];
            scriptData.hashtags = [...scriptData.hashtags, ...defaultTags].slice(0, 10);
          }
          
          console.log(`[generateReelsScript] ✅ Success: ${scriptData.scene_by_scene.length} scenes`);
          return scriptData;
        }
      }
      
      // If parsing or validation failed, use fallback
      throw new Error('Invalid JSON structure from Gemini');
    } catch (error) {
      console.error('[generateReelsScript] Gemini error:', error.message);
      throw error;
    }
  })();
  
  // Race between Gemini and timeout
  try {
    const scriptData = await Promise.race([geminiPromise, timeoutPromise]);
    
    // Success - return script data
    console.log(`[generateReelsScript] ✅ Returning script data`);
    return res.json({
      success: true,
      data: scriptData
    });
  } catch (error) {
    // Timeout or Gemini failure - return fallback (NEVER return 500)
    console.warn(`[generateReelsScript] ⚠️ Using fallback script (reason: ${error.message})`);
    
    const fallbackScript = getSimpleFallbackScript(language, topic, finalDuration);
    
    // Always return success with fallback data (never 500 error)
    return res.json({
      success: true,
      data: fallbackScript
    });
  }
}

/**
 * GET /ai/job-status/:jobId
 * Unified endpoint to check status of any async AI job
 * Returns: { success: true, status: 'pending' | 'done' | 'error', data?: {...}, error?: string }
 */
function getJobStatus(req, res) {
  const { jobId } = req.params;
  
  if (!jobId) {
    return res.status(400).json({ 
      success: false, 
      error: 'jobId is required' 
    });
  }
  
  const job = getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ 
      success: false, 
      error: 'Job not found',
      status: 'not_found'
    });
  }
  
  // Return job status and data (if done or error)
  const response = {
    success: true,
    status: job.status, // 'pending' | 'done' | 'error'
    jobId: job.jobId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  
  // Include data if job is done or error (always return data, even if fallback)
  if (job.status === 'done' || job.status === 'error') {
    response.data = job.data;
    
    // If no data, provide fallback based on job type
    if (!response.data) {
      switch (job.type) {
        case 'captions':
          response.data = getFallbackCaptions(job.language || 'English');
          break;
        case 'calendar':
          response.data = [];
          break;
        case 'strategy':
          response.data = {};
          break;
        case 'reels-script':
          response.data = transformScriptData(
            getFallbackReelsScript(job.language || 'English', job.topic || 'motivation', job.duration || '15s'),
            job.language || 'English',
            job.topic || 'motivation',
            job.duration || '15s'
          );
          break;
        default:
          response.data = {};
      }
    }
  }
  
  // Include error message if error status
  if (job.status === 'error' && job.error) {
    response.error = job.error;
  }
  
  console.log(`[getJobStatus] Job ${jobId} (type: ${job.type}) status: ${job.status}`);
  res.json(response);
}

module.exports = {
  generateCaptions,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
  generateReelsScript, // Legacy endpoint (kept for backward compatibility)
  getJobStatus, // Unified job status endpoint for all AI jobs
};

