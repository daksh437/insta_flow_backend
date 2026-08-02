const { runGemini, runGeminiWithImage, runGeminiImageGen } = require('../utils/geminiClient');
const { getAdmin, getDb } = require('../utils/firestoreAdmin');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const { processImageForGemini } = require('../utils/imageProcessor');
const { v4: uuidv4 } = require('uuid');
const { createJob, updateJob, generateJobId, getJob } = require('../utils/jobStore');
const { recordAiUsage } = require('../middleware/aiAccess');
const { loadCreatorContext, formatForPrompt } = require('../utils/creatorContext');

/** Only record AI usage when job completes successfully. Request lock: never double-count same job. */
function completeJobAndRecordUsage(jobId, status, data = {}) {
  const job = getJob(jobId);
  const isSuccess = (status === 'completed' || status === 'done') && !data.error;
  if (job && job.uid && isSuccess && !job.usageRecorded) {
    job.usageRecorded = true;
    recordAiUsage(job.uid, jobId);
  }
  updateJob(jobId, status, data);
}

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
 * Salvage complete top-level JSON objects from a possibly TRUNCATED array
 * response (e.g. when the model hits maxOutputTokens mid-array). Brace-counts
 * while respecting strings, returning every fully-closed `{...}` object and
 * discarding an incomplete trailing one. Used as a fallback for list endpoints
 * (e.g. multi-day calendars) so a cut-off response still yields usable items.
 */
function salvageJsonObjects(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          try { objects.push(JSON.parse(cleaned.substring(start, i + 1))); } catch (_) { /* skip */ }
          start = -1;
        }
      }
    }
  }
  return objects;
}

/**
 * Extract captions from plain text response (when JSON parsing fails)
 * Treats Gemini output as RAW TEXT and extracts captions using robust logic
 * @param {string} text - Raw text from Gemini
 * @param {string} language - Language for fallback captions
 * @returns {Array<Object>} - Array of caption objects with text and hashtags (5-7 captions)
 */
function extractCaptionsFromText(text, language = 'English') {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.log('[extractCaptionsFromText] Empty or invalid text input');
    return [];
  }

  console.log('[extractCaptionsFromText] Extracting captions from plain text, length:', text.length);
  console.log('[extractCaptionsFromText] Raw text preview:', text.substring(0, 200));
  
  // Step 1: Normalize text - remove extra whitespace but preserve structure
  let normalizedText = text.trim();
  
  // Step 2: Split by double newlines first (captions might be separated by blank lines)
  let blocks = normalizedText.split(/\n\s*\n/);
  
  // If no double newlines, split by single newlines
  if (blocks.length === 1) {
    blocks = normalizedText.split(/\r?\n/);
  }
  
  console.log('[extractCaptionsFromText] Split into', blocks.length, 'blocks/lines');
  
  // Step 3: Clean and filter blocks, extract text and hashtags
  const captions = [];
  const styles = ['story', 'question', 'bold', 'emotional', 'action', 'aesthetic', 'punchline'];
  
  for (let block of blocks) {
    // Remove leading/trailing whitespace
    block = block.trim();
    
    // Skip empty blocks
    if (!block || block.length === 0) continue;
    
    // Skip lines that contain JSON markers (more specific checks)
    const blockTrimmed = block.trim();
    
    // Skip exact JSON structure markers
    if (blockTrimmed === '"captions":' || 
        blockTrimmed.startsWith('"captions":') ||
        blockTrimmed === '"hashtags":' ||
        blockTrimmed.startsWith('"hashtags":') ||
        blockTrimmed === '[' ||
        blockTrimmed === '{' ||
        blockTrimmed === ']' ||
        blockTrimmed === '}') {
      console.log(`[extractCaptionsFromText] Skipping JSON marker: ${block.substring(0, 50)}`);
      continue;
    }
    
    // Skip if it's a JSON object/array that's too short (likely a structure marker)
    if ((blockTrimmed.startsWith('{') || blockTrimmed.startsWith('[')) && 
        blockTrimmed.length < 50 &&
        (blockTrimmed.includes('"captions":') || blockTrimmed.includes('"hashtags":'))) {
      console.log(`[extractCaptionsFromText] Skipping short JSON structure: ${block.substring(0, 50)}`);
      continue;
    }
    
    // Skip if entire block is just quotes (JSON string marker)
    if (blockTrimmed.startsWith('"') && blockTrimmed.endsWith('"') && blockTrimmed.length < 20) {
      console.log(`[extractCaptionsFromText] Skipping quoted JSON marker: ${block.substring(0, 50)}`);
      continue;
    }
    
    // Remove numbering patterns: "1.", "2.", "1)", "-", "•", "*", etc.
    block = block.replace(/^[\d]+[\.\)]\s*/, ''); // "1. ", "2) "
    block = block.replace(/^[-•*]\s*/, ''); // "- ", "• ", "* "
    block = block.replace(/^[\u2022\u2023\u25E6\u2043]\s*/, ''); // Unicode bullet points
    block = block.trim();
    
    // Skip if block is too short (likely not a caption) or too long (likely not a caption)
    if (block.length < 10 || block.length > 300) {
      console.log('[extractCaptionsFromText] Skipping block (length:', block.length, '):', block.substring(0, 50));
      continue;
    }
    
    // Skip lines that look like JSON structure markers
    if (block.match(/^[\[\{\}\]]+$/)) continue;
    
    // Skip lines that contain JSON-like structure (but allow if it's part of caption)
    if (block.match(/^[\{\[]\s*["']caption["']/) || block.match(/^[\{\[]\s*["']text["']/)) {
      console.log('[extractCaptionsFromText] Skipping JSON-like block:', block.substring(0, 50));
      continue;
    }
    
    // Skip lines that are ONLY hashtags (no text before hashtags)
    if (block.match(/^(\s*#[\w]+(\s+#[\w]+)*\s*)+$/)) {
      console.log('[extractCaptionsFromText] Skipping hashtag-only block');
      continue;
    }
    
    // Extract hashtags from anywhere in the block (not just end)
    let captionText = block;
    let hashtags = [];
    
    // Find all hashtags in the block (including those in middle)
    const allHashtags = block.match(/#[\w]+/g) || [];
    
    if (allHashtags.length > 0) {
      // Remove hashtags from the text (replace with space, then clean up)
      captionText = block.replace(/#[\w]+/g, ' ').replace(/\s+/g, ' ').trim();
      hashtags = allHashtags;
    }
    
    // Remove common prefixes
    captionText = captionText.replace(/^(Caption|Text|Style|Title):\s*/i, '');
    captionText = captionText.trim();
    
    // Additional cleanup: remove quotes if entire caption is quoted
    if ((captionText.startsWith('"') && captionText.endsWith('"')) ||
        (captionText.startsWith("'") && captionText.endsWith("'"))) {
      captionText = captionText.slice(1, -1).trim();
    }
    
    // CRITICAL: Skip if caption text contains JSON structure markers (BEFORE length check)
    if (captionText.includes('"captions":') || 
        captionText.includes('"hashtags":') ||
        captionText.trim() === '"captions":' ||
        captionText.trim() === '"hashtags":' ||
        captionText.trim().startsWith('"captions":') ||
        captionText.trim().startsWith('"hashtags":') ||
        (captionText.trim().startsWith('{') && (captionText.includes('"captions":') || captionText.includes('"hashtags":'))) ||
        (captionText.trim().startsWith('[') && captionText.length < 100) ||
        captionText.match(/^["']hashtags["']:\s*\[/)) {
      console.log('[extractCaptionsFromText] ⚠️ Skipping - text contains JSON structure:', captionText.substring(0, 50));
      continue;
    }
    
    // Final validation: caption text must have meaningful content
    if (captionText.length >= 10 && captionText.length <= 300) {
      // Ensure caption text is not just whitespace or special characters
      const meaningfulText = captionText.replace(/[^\w\s]/g, '').trim();
      if (meaningfulText.length >= 5) {
        // Final check: ensure text doesn't start with JSON markers
        const finalText = captionText.trim();
        if (finalText.startsWith('"captions":') || 
            finalText.startsWith('"hashtags":') ||
            finalText === '"captions":' ||
            finalText === '"hashtags":') {
          console.log('[extractCaptionsFromText] ⚠️ Final check - skipping JSON marker:', finalText.substring(0, 50));
          continue;
        }
        
        captions.push({
          style: styles[captions.length % styles.length] || 'general',
          text: captionText,
          hashtags: hashtags
        });
        console.log('[extractCaptionsFromText] ✅ Extracted caption:', captionText.substring(0, 50) + '...', 'hashtags:', hashtags.length);
      } else {
        console.log('[extractCaptionsFromText] Skipping block (not meaningful):', captionText.substring(0, 50));
      }
    } else {
      console.log('[extractCaptionsFromText] Skipping block (invalid length):', captionText.length);
    }
  }
  
  console.log('[extractCaptionsFromText] Extracted', captions.length, 'captions from text');
  
  // Step 4: If we got fewer than 3 captions, try alternative splitting
  if (captions.length < 3) {
    console.log('[extractCaptionsFromText] ⚠️ Only found', captions.length, 'captions, trying alternative parsing...');
    
    // Try splitting by numbered items (1., 2., etc.)
    const numberedPattern = /(\d+[\.\)]\s*[^\d]+)/g;
    const numberedMatches = text.match(numberedPattern);
    
    if (numberedMatches && numberedMatches.length > 0) {
      console.log('[extractCaptionsFromText] Found', numberedMatches.length, 'numbered items');
      captions.length = 0; // Clear existing
      
      for (let match of numberedMatches) {
        let item = match.replace(/^\d+[\.\)]\s*/, '').trim();
        
        // Extract hashtags
        const itemHashtags = item.match(/#[\w]+/g) || [];
        let itemText = item.replace(/#[\w]+/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (itemText.length >= 10 && itemText.length <= 300) {
          captions.push({
            style: styles[captions.length % styles.length] || 'general',
            text: itemText,
            hashtags: itemHashtags
          });
        }
      }
    }
  }
  
  // Step 5: Limit to 5-7 captions
  const finalCaptions = captions.slice(0, 7);
  console.log('[extractCaptionsFromText] Final captions count:', finalCaptions.length);
  
  // Log final captions for debugging
  finalCaptions.forEach((cap, idx) => {
    console.log(`[extractCaptionsFromText] Caption ${idx + 1}:`, {
      style: cap.style,
      textLength: cap.text.length,
      textPreview: cap.text.substring(0, 50) + '...',
      hashtagsCount: cap.hashtags.length
    });
  });
  
  return finalCaptions;
}

/**
 * Get fallback captions when Gemini fails or returns empty response
 * @param {string} language - Language for fallback captions
 * @returns {Array<Object>} - Array of caption objects with style, text, hashtags
 */
function getFallbackCaptions(language = 'English', topic = '') {
  const timestamp = Date.now();
  const topicHash = topic ? topic.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : 0;
  const randomIndex = (timestamp + topicHash) % 10;
  
  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 3);
  const mainKeyword = keywords[0] || 'content';
  const hashtag = `#${mainKeyword.replace(/[^a-z0-9]/g, '')}`;
  
  console.log('[getFallbackCaptions] Using fallback captions for language:', language, 'topic:', topic, 'index:', randomIndex, 'hashtag:', hashtag);
  
  if (language === 'Hindi') {
    return [
      { style: 'motivational', text: 'हर दिन एक नई शुरुआत है। आगे बढ़ते रहो! 💪', hashtags: [hashtag, '#motivation', '#hindi', '#inspiration'] },
      { style: 'aesthetic', text: 'सुंदरता आपके अंदर है। इसे खोजें। ✨', hashtags: [hashtag, '#aesthetic', '#beauty', '#hindi'] },
      { style: 'confident', text: 'आप जो चाहें वो कर सकते हैं। यकीन रखें! 🔥', hashtags: [hashtag, '#confidence', '#power', '#hindi'] },
      { style: 'emotional', text: 'भावनाएं हमें इंसान बनाती हैं। ❤️', hashtags: [hashtag, '#emotions', '#feelings', '#hindi'] },
      { style: 'story', text: 'हर कहानी में एक सबक है। सीखते रहें। 📖', hashtags: [hashtag, '#story', '#life', '#hindi'] },
    ];
  } else if (language === 'Hinglish') {
    return [
      { style: 'motivational', text: `Progress over perfection. आगे बढ़ते रहो! 💪`, hashtags: [hashtag, '#motivation', '#progress', '#hinglish'] },
      { style: 'confident', text: `Strong body, stronger mindset. तुम कर सकते हो! 🔥`, hashtags: [hashtag, '#fitness', '#mindset', '#hinglish'] },
      { style: 'aesthetic', text: `Beauty is in the details. खूबसूरती यहीं है। ✨`, hashtags: [hashtag, '#aesthetic', '#beauty', '#hinglish'] },
      { style: 'emotional', text: `Feelings matter. भावनाएं ज़रूरी हैं। ❤️`, hashtags: [hashtag, '#feelings', '#emotions', '#hinglish'] },
      { style: 'story', text: `Every story has a lesson. हर कहानी में सीख है। 📖`, hashtags: [hashtag, '#story', '#life', '#hinglish'] },
    ];
  } else {
    // Topic-aware last-resort captions (never generic #energy/#shine filler).
    const topic1 = mainKeyword.charAt(0).toUpperCase() + mainKeyword.slice(1);
    const tags = [
      hashtag,
      ...keywords.slice(1).map((k) => '#' + k.replace(/[^a-z0-9]/g, '')),
      '#reels', '#viral', '#instagram', '#trending', '#explore',
      '#contentcreator', '#fyp', '#instadaily',
    ].filter((t, i, a) => t.length > 1 && a.indexOf(t) === i).slice(0, 10);
    return [
      { style: 'viral', text: `POV: you just found your new favorite ${mainKeyword}. Save this before you forget. 🔥`, hashtags: tags },
      { style: 'relatable', text: `${topic1} hits different today. Tag someone who needs to see this. 👀`, hashtags: tags },
      { style: 'engaging', text: `Stop scrolling — your next ${mainKeyword} moment is right here. Drop a 🔥 if you agree.`, hashtags: tags },
    ];
  }
}

function getSystemPrompt() {
  return `You are a world-class Instagram Reels caption strategist who has written viral captions for creators with millions of followers. You know exactly what makes people STOP scrolling, feel something, and ENGAGE (save, share, comment).

ANALYZE SILENTLY (never output this): the topic/niche, target audience & mindset, goal, the core emotion to trigger, and the language & tone.

WRITE using proven virality craft. Each caption must have:
- HOOK: opening words stop the scroll in under 1 second (bold claim, curiosity gap, relatable pain, "POV", surprising fact, or a sharp question). Never a boring intro.
- PAYOFF: a short beat that delivers value/emotion so they feel seen or intrigued.
- CTA: a specific, creative call-to-action that drives SAVES / SHARES / COMMENTS (vary it). Never generic.
- Emojis: natural, 1–4, never spammy.

RULES (STRICT):
- HONOR EVERY EXPLICIT INSTRUCTION in the user's request — number of hashtags, word/character limit, tone, required CTA, best posting time, language, format. If they ask for 10 hashtags, give exactly 10. If they name a tone (e.g. Gen Z), match it precisely.
- Generate EXACTLY 3 captions, each a COMPLETELY different angle, hook, wording, CTA, and hashtag set.
- Hashtags: 8–10 specific, relevant tags per caption unless the user asked for a different number — mix niche + medium-reach + a couple broad. NEVER lazy/generic (#love #instagood #viral #followforfollow) and NEVER off-topic filler (#write #energy #shine).
- LANGUAGE (critical): detect the language and script the user wrote the request in and write ALL captions in that SAME language and script (Hindi request → Devanagari Hindi, English → English, etc.). If the user explicitly names a language anywhere (e.g. "in Hindi", "in English", "in Tamil", "in Marathi"), use THAT language instead — override everything, never default to English. Hashtags may stay romanized/English.
- BANNED dead phrases: "Don't miss this", "Follow for more", "Like and share".
- Fresh captions every time, even for a repeated request.

OUTPUT — return ONLY valid minified JSON, no markdown, no code fences, no commentary:
{"captions":[{"style":"<viral|funny|luxury|emotional|energetic>","text":"<caption, may include line breaks, NO hashtags in this field>","hashtags":["#tag1","#tag2","...8-10 tags"]},{...},{...}],"best_time":"<best posting time for this audience; use IST for an Indian audience, e.g. 6:00-9:00 PM IST, Fri-Sun>"}`;
}

function getUserPrompt(userInput, generationId, creativeSeed, requestId, regenerate) {
  const regenerateWarning = regenerate 
    ? `\n\n🚨🚨🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨🚨🚨\n\nCRITICAL: Generate 3 COMPLETELY FRESH captions with:\n- NEW angle and perspective for each caption\n- NEW wording (zero word reuse)\n- NEW hook structure for each caption\n- NEW hashtags for each caption\n- NEW emoji placement for each caption\n- NEW sentence structure for each caption\n\nDO NOT reuse ANYTHING from previous generation.\n\n`
    : '';
  
  const timestamp = Date.now();
  const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}-${Math.random().toString(36).substring(2, 10)}`;
  const variationToken = Math.random().toString(36).substring(2, 20);

  const forcedLang = detectRequestedLanguage(userInput);
  const langDirective = forcedLang
    ? `⚠️⚠️ OUTPUT LANGUAGE = ${forcedLang.toUpperCase()}. Write every caption's text ENTIRELY in ${forcedLang} — not English. (Hashtags may stay romanized.)\n\n`
    : '';

  const reqTags = detectRequestedHashtagCount(userInput);
  const hashtagDirective = reqTags
    ? `⚠️⚠️ Each caption's "hashtags" array MUST contain EXACTLY ${reqTags} hashtags — count them, no more and no fewer.\n\n`
    : '';

  return `${langDirective}${hashtagDirective}${regenerateWarning}Generate EXACTLY 3 UNIQUE Instagram Reels captions based on this request:

"${userInput}"

🎲 CREATIVE_SEED: ${creativeSeed}
🆔 REQUEST_ID: ${generationId}
📅 TIMESTAMP: ${timestamp}
🔄 CLIENT_REQUEST_ID: ${requestId || 'none'}
🎲 RANDOM_CONTEXT: ${randomContext}
🔑 VARIATION_TOKEN: ${variationToken}

CRITICAL UNIQUENESS REQUIREMENTS:
- This request ID (${generationId}) is UNIQUE - generate 3 DIFFERENT captions than any previous request
- Use the creative seed (${creativeSeed.substring(0, 30)}...) to ensure maximum variation
- The timestamp ${timestamp} and random context ${randomContext} ensure this is a fresh generation
- Even if the user input is identical, all 3 captions MUST be completely different
- Each of the 3 captions must be unique from each other (different hooks, structure, hashtags)

INSTRUCTIONS:
- FIRST, obey every explicit requirement stated in the request above (hashtag count, word/character limit, tone, CTA, best posting time, language, format). These are non-negotiable.
- Understand tone, language, and audience automatically from the description.
- Generate EXACTLY 3 completely DIFFERENT captions — each a unique hook, structure, CTA, and hashtag set.
- Start each with a strong scroll-stopping hook; natural emojis; human, fresh wording.
- Hashtags: 8-10 relevant tags per caption (or the exact number the user asked for), all on-topic — different set for each caption.
- If regenerate=true, use completely different angles and wording for all 3.

OUTPUT: return ONLY the JSON object described in the system prompt (keys: captions[].style, captions[].text, captions[].hashtags[], best_time). No markdown, no code fences, no text before or after the JSON.`;
}

/**
 * @param {string} topic
 * @param {number} days - clamped 1–30 on caller
 * @param {string} [tone] - e.g. Professional, Casual, Funny
 * @param {string} [goal] - e.g. engagement, followers, sales
 */
function calendarPrompt(topic, days, tone, goal) {
  const d = Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 30) : 7;
  const toneStr = (tone && String(tone).trim()) ? String(tone).trim() : 'balanced / natural for the niche';
  const goalStr = (goal && String(goal).trim()) ? String(goal).trim() : 'engagement and community growth';
  return `You are an elite Instagram content strategist who plans calendars for creators who grow fast. You balance formats, hooks, and posting times for maximum reach and consistency.

Before planning, silently analyze the niche "${topic}": the audience, what content performs best in this space, and a healthy mix of educational / relatable / promotional posts. Match the language of the topic if it's Hindi/Hinglish.

Create a ${d}-DAY content calendar for the niche/topic: "${topic}".

Constraints:
- Writing tone (apply to every caption and CTA): ${toneStr}
- Primary goal (shape CTAs and content mix): ${goalStr}

Return EXACTLY ${d} objects in ONE JSON array (no markdown, no code fences).

Each object MUST use these keys (same names for parsing):
- "day" (number 1..${d}, or day label)
- "day_of_week" (e.g. Monday)
- "content_type" (Reel / Carousel / Story / Static Image / Meme)
- "hook" (strong first line)
- "caption" (ready-to-post; human, on-brand for the tone above)
- "hashtags" (array of 10-15 strings; may include # or plain words — be consistent)
- "hashtag_set" (optional: same as hashtags if you need a second field)
- "best_post_time" (IST, e.g. "7:00 PM IST") — also acceptable: "best_posting_time"
- "content_brief" (what to film or design)
- "viral_angle" (one line why it could perform)
- "cta" (call to action aligned with the goal)

Rules:
- Use different angles, hooks, and hashtag sets each day; no copy-paste across days.
- JSON only: a single array [...] of ${d} items.`;
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

function advisorPrompt(feature, context, sampleOutput, strictRetry = false) {
  const stricter = strictRetry
    ? '\nSTRICT RETRY: previous advice was generic. Make it more specific to user context and measurable.'
    : '';
  return `You are an honest Instagram growth advisor.

Feature: ${feature}
User context:
${JSON.stringify(context)}

AI output sample:
${typeof sampleOutput === 'string' ? sampleOutput : JSON.stringify(sampleOutput)}

Return ONLY valid JSON with keys:
{
  "diagnosis": "",
  "why_it_matters": "",
  "action_steps": ["", "", ""],
  "expected_outcome": "",
  "avoid_this": "",
  "confidence_note": "",
  "quick_win": ""
}

Rules:
- Keep it practical and concise.
- No fake promises, no guaranteed viral claims.
- 3-5 action steps, imperative and measurable.
- If uncertain, use likely/safe language.${stricter}`;
}

function fallbackAdvice(feature, context) {
  const topic = String(context?.topic || context?.input || 'your content').trim();
  return {
    diagnosis: `Your ${feature} output likely needs a sharper first hook and a clearer CTA for ${topic}.`,
    why_it_matters: 'Hook quality affects stop-rate, and CTA clarity improves saves, shares, and actions.',
    action_steps: [
      'Keep the first line under 9 words and benefit-led.',
      'Add one specific CTA (Save this / Comment keyword / Share).',
      'Use niche-specific phrasing instead of broad generic wording.',
    ],
    expected_outcome: 'Likely better watch-through and higher engagement quality over the next few posts.',
    avoid_this: 'Avoid generic lines and over-promising language like guaranteed viral.',
    confidence_note: 'Medium confidence based on provided context; test 2 variants and compare saves/comments.',
    quick_win: 'Rewrite your first line into a benefit + curiosity hook before posting.',
  };
}

function normalizeAdvice(raw, feature, context) {
  const base = fallbackAdvice(feature, context);
  const src = raw && typeof raw === 'object' ? raw : {};
  const toText = (v, fb) => (typeof v === 'string' && v.trim() ? v.trim() : fb);
  const actionStepsRaw = Array.isArray(src.action_steps) ? src.action_steps : [];
  let action_steps = actionStepsRaw
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  if (action_steps.length < 3) {
    action_steps = [...action_steps, ...base.action_steps].slice(0, 3);
  }
  const cleanFake = (text) =>
    String(text || '')
      .replace(/\b(guaranteed?|100%|definitely viral|instant viral|sure-shot)\b/gi, 'likely')
      .trim();
  return {
    diagnosis: cleanFake(toText(src.diagnosis, base.diagnosis)),
    why_it_matters: cleanFake(toText(src.why_it_matters, base.why_it_matters)),
    action_steps: action_steps.map(cleanFake),
    expected_outcome: cleanFake(toText(src.expected_outcome, base.expected_outcome)),
    avoid_this: cleanFake(toText(src.avoid_this, base.avoid_this)),
    confidence_note: cleanFake(toText(src.confidence_note, base.confidence_note)),
    quick_win: cleanFake(toText(src.quick_win, base.quick_win)),
  };
}

function scoreAdvice(advice, context) {
  let score = 0;
  const diagnosis = String(advice?.diagnosis || '').toLowerCase();
  const ctxText = JSON.stringify(context || {}).toLowerCase();
  if (diagnosis.length >= 20 && (ctxText.length < 5 || diagnosis.includes(String(context?.topic || '').toLowerCase()) || diagnosis.includes('you'))) score += 1;
  if (Array.isArray(advice?.action_steps) && advice.action_steps.length >= 3 && advice.action_steps.some((s) => /\d|under|at least|per|daily|weekly/i.test(String(s)))) score += 1;
  if (String(advice?.expected_outcome || '').length >= 20) score += 1;
  if (String(advice?.avoid_this || '').length >= 10) score += 1;
  if (!/\b(guaranteed?|100%|definitely viral|instant viral|sure-shot)\b/i.test(JSON.stringify(advice || {}))) score += 1;
  return score;
}

async function buildAdvisor(feature, context, sampleOutput) {
  let normalized = false;
  let regenerated = false;
  try {
    const first = await runGemini(advisorPrompt(feature, context, sampleOutput, false), {
      maxTokens: 900,
      temperature: 0.5,
      topP: 0.9,
    });
    let advice = normalizeAdvice(tryParseJson(first, {}), feature, context);
    normalized = true;
    let score = scoreAdvice(advice, context);
    if (score < 4) {
      regenerated = true;
      const second = await runGemini(advisorPrompt(feature, context, sampleOutput, true), {
        maxTokens: 900,
        temperature: 0.45,
        topP: 0.9,
      });
      advice = normalizeAdvice(tryParseJson(second, {}), feature, context);
      score = scoreAdvice(advice, context);
      if (score < 4) {
        advice = normalizeAdvice(advice, feature, context);
      }
      const withMeta = {
        ...advice,
        _meta_score: score,
        _meta_regenerated: regenerated,
        _meta_low_confidence: score < 4,
      };
      console.log(`[AIAdvice] feature=${feature} score=${score} normalized=${normalized} regenerated=${regenerated}`);
      return withMeta;
    }
    const withMeta = {
      ...advice,
      _meta_score: score,
      _meta_regenerated: regenerated,
      _meta_low_confidence: score < 4,
    };
    console.log(`[AIAdvice] feature=${feature} score=${score} normalized=${normalized} regenerated=${regenerated}`);
    return withMeta;
  } catch (e) {
    console.warn(`[AIAdvice] feature=${feature} fallback used:`, e.message);
    return {
      ...fallbackAdvice(feature, context),
      _meta_score: 0,
      _meta_regenerated: false,
      _meta_low_confidence: true,
    };
  }
}

function nicheAnalysisPrompt(topic) {
  return `You are a top Instagram growth strategist who has scaled accounts in many niches. You know current Reel trends, hook psychology, and hashtag competition.

STEP 1 — Analyze silently (never output this): who follows the "${topic}" niche, what they scroll for, which formats are peaking on Reels right now, where competitors are weak, and which emotions drive saves/shares in this niche.

STEP 2 — Return a niche report for "${topic}". Be SPECIFIC and ACTIONABLE, never generic. Every item should be something a creator can act on today, with concrete examples (real hook lines, real hashtag examples, concrete formats). No filler like "post consistently".

Return STRICT JSON in EXACTLY this shape (keys and types must match):

{
  "trend_forecast_30_days": "3-5 sentences naming concrete trends, formats, audio styles and content angles rising in this niche over the next 30 days — specific, not vague.",
  "top_5_viral_patterns": [
    { "pattern": "short name of the pattern (e.g. 'Before/after in 3 seconds')", "reason": "why it works in THIS niche + an example hook line to use" }
  ],
  "best_3_reel_formats": [
    { "format": "format name", "description": "exactly how to shoot/structure it for this niche (shots, length, on-screen text)", "expected_performance": "what result to expect, e.g. 'high saves, strong reach for cold audience'" }
  ],
  "hashtag_clusters": {
    "low_competition": ["10 niche-specific low-competition hashtags, with # prefix"],
    "mid_competition": ["10 mid-competition hashtags"],
    "high_competition": ["10 broad high-competition hashtags"]
  },
  "untapped_content_ideas": ["6-8 fresh content angles competitors in this niche are NOT doing — each a concrete idea, not a category"],
  "psychological_triggers": [
    { "trigger": "trigger name (e.g. curiosity gap, social proof)", "application": "one concrete way to use it in this niche", "effectiveness": "High / Medium and a short why" }
  ],
  "common_mistakes": [
    { "mistake": "a specific mistake creators make in this niche AND the fix, in one sentence" }
  ]
}

Rules:
- top_5_viral_patterns: exactly 5. best_3_reel_formats: exactly 3. hashtag clusters: exactly 10 each with real "#tag" examples relevant to "${topic}".
- Everything must be tailored to "${topic}" specifically — a reader should not be able to swap in another niche.
- Output ONLY the JSON, no markdown, no commentary.`;
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
// Text-only caption fallback used only when the single-pass Vision call returns
// no captions — generates from the coarse vibe the Vision step extracted.
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

// Single-pass image → captions. The Vision model SEES the actual photo and
// writes captions that reference what's really in it (subject, action, colours,
// setting, visible text) — far more specific than the old attributes-only path.
function imageCaptionPrompt() {
  const seed = Date.now() + Math.random();
  return `VARIATION_SEED: ${seed}

You are an expert Instagram caption writer. LOOK CAREFULLY at the attached image and write captions that clearly fit THIS specific photo — reference what is actually visible: the subject, what they are doing, colours, outfit, location/background, objects, and any visible text or logos. Do NOT write generic captions that could fit any photo.

IMPORTANT: Always respond. Even if the image is a quote/text graphic, a "good morning" image, a meme, or has a watermark, still describe the visible scene/background and write captions for it — NEVER refuse and NEVER explain, just output the JSON. If the image contains readable text (e.g. a Hindi quote or a greeting), use its theme to inspire the captions.

Output ONLY the JSON object below — no preamble, no markdown, no explanation.

First briefly analyse the image, then write 5 captions.

Rules:
- Every caption must reflect something REAL in this exact image.
- 5 captions, each a DIFFERENT style: aesthetic, confident, story-based, short punchline, emotional.
- Under 150 characters each. Natural, human, scroll-stopping. Emojis where they fit.
- Write in English by default. If there is clearly non-English text in the image, you may match that language.
- The audience is primarily in INDIA — where it genuinely fits the photo, use India-relevant references/tags naturally. Never force India onto an unrelated photo.
- 8-12 specific, relevant hashtags per caption (mix of broad + niche). Never spam #love #viral #instagood.

Return STRICT JSON only:
{
  "analysis": { "scene": "indoor or outdoor", "setting": "short phrase", "mood": "short phrase", "time": "day or night", "occasion": "short phrase or 'not clearly visible'" },
  "captions": [
    { "angle": "aesthetic", "text": "[under 150 chars]", "hashtags": ["#tag1", "#tag2"] },
    { "angle": "confident", "text": "[under 150 chars]", "hashtags": ["#tag1", "#tag2"] },
    { "angle": "story-based", "text": "[under 150 chars]", "hashtags": ["#tag1", "#tag2"] },
    { "angle": "short punchline", "text": "[under 150 chars]", "hashtags": ["#tag1", "#tag2"] },
    { "angle": "emotional", "text": "[under 150 chars]", "hashtags": ["#tag1", "#tag2"] }
  ]
}`;
}

/**
 * Parse the caption model output. Prefers JSON
 * ({captions:[{style,text,hashtags}], best_time}); falls back to the legacy
 * bullet/line format. Returns { captions: [{style,text,hashtags}], bestTime }.
 * Robust JSON parsing here is what stopped the app from dumping generic
 * fallback captions when the old line-splitter mis-parsed rich output.
 */
function parseCaptionsResponse(output) {
  const result = { captions: [], bestTime: '' };
  if (!output || typeof output !== 'string') return result;
  const raw = output.trim();

  // 1) JSON (strip code fences, take the outermost object).
  try {
    let jsonText = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(jsonText.slice(start, end + 1));
      const arr = Array.isArray(parsed.captions) ? parsed.captions : [];
      for (const c of arr) {
        const text = String((c && (c.text || c.caption)) || '').trim();
        if (!text) continue;
        const tags = (Array.isArray(c.hashtags) ? c.hashtags : [])
          .map((t) => String(t).trim())
          .filter(Boolean)
          .map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, '')));
        result.captions.push({
          style: String((c && c.style) || 'general').toLowerCase(),
          text,
          hashtags: tags,
        });
      }
      result.bestTime = String(parsed.best_time || parsed.bestTime || '').trim();
      if (result.captions.length > 0) return result;
    }
  } catch (e) {
    // fall through to legacy line parsing
  }

  // 2) Legacy line format: "• caption text ... #tag1 #tag2"
  const cleaned = raw
    .replace(/^[•\-*]\s*/gm, '')
    .replace(/^\d+[\.)]\s*/gm, '')
    .trim();
  const lines = cleaned.split(/\n/).filter((l) => l.trim().length > 10);
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const line = lines[i].trim();
    const tags = line.match(/#[\w]+/g) || [];
    const text = line.replace(/#[\w]+/g, '').trim();
    if (text.length > 10) {
      result.captions.push({ style: 'general', text, hashtags: tags });
    }
  }
  return result;
}

/**
 * Background processing function for captions generation
 * Runs Gemini API call asynchronously and updates job status
 */
async function processCaptions(jobId, userInput, regenerate, requestId) {
  console.log(`[processCaptions] Starting background processing for job: ${jobId}`);
  console.log(`[processCaptions] Request ID from client: ${requestId}`);
  
  try {
    const timestamp = Date.now();
    const microsecond = Number(process.hrtime.bigint() % 1000000n);
    const finalRequestId = requestId || `BACKEND-${timestamp}-${Math.random().toString(36).substring(2, 15)}-${userInput.substring(0, 10)}-${regenerate ? 'REGEN' : 'NEW'}`;
    const generationId = `${timestamp}-${microsecond}-${Math.random().toString(36).substring(2, 15)}-${regenerate ? 'REGEN' : 'NEW'}-${Math.random().toString(36).substring(2, 10)}`;
    const creativeSeed = `${uuidv4()}-${timestamp}-${microsecond}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 10)}-${finalRequestId.substring(0, 20)}`;
    
    console.log(`[processCaptions] Generation ID: ${generationId}`);
    console.log(`[processCaptions] Creative Seed: ${creativeSeed.substring(0, 50)}...`);
    
    const systemPrompt = getSystemPrompt();
    const userPrompt = getUserPrompt(userInput, generationId, creativeSeed, finalRequestId, regenerate);
    
    let output = '';
    try {
      const uniqueSeed = timestamp + Number(microsecond) + Math.floor(Math.random() * 1000000);
      
      console.log(`[processCaptions] Unique Seed for Gemini: ${uniqueSeed}`);
      console.log(`[processCaptions] User Prompt length: ${userPrompt.length}`);
      console.log(`[processCaptions] System Prompt length: ${systemPrompt.length}`);
      
      output = await runGemini(userPrompt, { 
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        maxTokens: 2000,
        temperature: 1.0,
        topP: 0.95,
        topK: 50,
        randomSeed: uniqueSeed
      });
      
      console.log(`[processCaptions] ✅ Gemini API success, output length: ${output?.length || 0}`);
      if (output) {
        console.log(`[processCaptions] Output preview: ${output.substring(0, 200)}...`);
      }
    } catch (geminiError) {
      console.error('[processCaptions] ❌ Gemini API call failed:', geminiError.message);
      console.error('[processCaptions] Error stack:', geminiError.stack);
      output = '';
    }
    
    // Parse the model output — JSON preferred, legacy line format as fallback.
    const parsed = parseCaptionsResponse(output);
    let captions = parsed.captions;
    const bestTime = parsed.bestTime;
    console.log(`[processCaptions] Parsed ${captions.length} captions${bestTime ? `, best_time="${bestTime}"` : ''}`);

    // Top up any shortfall with TOPIC-AWARE fallback (never generic filler).
    if (captions.length < 3) {
      console.log(`[processCaptions] ⚠️ Only ${captions.length} captions parsed, topping up with fallback`);
      const fallback = getFallbackCaptions('English', userInput);
      for (let i = captions.length; i < 3 && fallback.length > 0; i++) {
        captions.push(fallback[i % fallback.length]);
      }
    }

    // Ensure we have exactly 3 captions; attach best_time to the first.
    captions = captions.slice(0, 3);
    if (bestTime && captions[0]) captions[0].best_time = bestTime;
    const advice = await buildAdvisor(
      'captions',
      { input: userInput, captionCount: captions.length },
      captions
    );
    captions = captions.map((c, i) => (i === 0 ? { ...c, ai_advice: advice } : c));
    
    // Update job with completed status - return 3 captions
    completeJobAndRecordUsage(jobId, 'done', { data: captions });
    console.log(`[processCaptions] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processCaptions] Error processing job ${jobId}:`, error);
    console.error(`[processCaptions] Error details:`, error.stack);
    const fallback = getFallbackCaptions('English', userInput);
    completeJobAndRecordUsage(jobId, 'done', { data: [fallback[0] || { style: 'general', text: 'Ready to create amazing content? Let\'s go! 🚀', hashtags: ['#motivation'] }], error: error.message });
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
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/captions' }));
  const { userInput, regenerate, requestId } = req.body || {};
  
  // Validate required parameters
  if (!userInput || userInput.trim() === '') {
    return res.status(400).json({ success: false, error: 'User input is required', data: [] });
  }
  
  // Generate unique job ID
  const jobId = generateJobId('CAPTIONS');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'captions',
    uid: req.uid,
    userInput: userInput.trim(),
    regenerate,
  });
  
  console.log(`[generateCaptions] ===== NEW ASYNC REQUEST =====`);
  console.log(`[generateCaptions] Job ID: ${jobId}`);
  console.log(`[generateCaptions] User Input: "${userInput}", Regenerate: ${regenerate}`);
  
  // Start background processing (non-blocking)
  processCaptions(jobId, userInput.trim(), regenerate, requestId)
    .catch((error) => {
      console.error(`[generateCaptions] Background processing failed for job ${jobId}:`, error);
      console.error(`[generateCaptions] Error stack:`, error.stack);
      const fallback = getFallbackCaptions('English', userInput.trim() || '');
      completeJobAndRecordUsage(jobId, 'done', {
        data: [fallback[0] || { style: 'general', text: 'Ready to create amazing content! Let\'s go! 🚀', hashtags: ['#motivation'] }],
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
async function processCalendar(jobId, topic, days, tone, goal) {
  console.log(`[processCalendar] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    const targetDays = Math.min(Math.max(Number.isFinite(days) ? Math.floor(days) : 7, 1), 30);
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const uniquePrompt = `${calendarPrompt(topic, days, tone, goal)}\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}`;
    
    // Scale output budget with the number of days so 14/30-day calendars are
    // not truncated mid-JSON (4096 only fit ~7 full day objects). Capped at 8192.
    const maxTokens = Math.min(8192, Math.max(2048, targetDays * 320 + 512));
    console.log(`[processCalendar] Calling Gemini API (maxTokens=${maxTokens} for ${targetDays} days)...`);
    const output = await runGemini(uniquePrompt, {
      maxTokens,
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processCalendar] Gemini response received, length:', output?.length || 0);

    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }

    let data = tryParseJson(output, []);

    // If the array was truncated (model hit the token cap), the strict parser
    // returns nothing — salvage whatever complete day objects we can. The
    // normalize/pad step below then tops it up to the requested day count.
    if (!Array.isArray(data) || data.length === 0) {
      const salvaged = salvageJsonObjects(output);
      if (salvaged.length > 0) {
        console.log(`[processCalendar] strict parse empty; salvaged ${salvaged.length} day object(s) from truncated output`);
        data = salvaged;
      }
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid calendar data from Gemini API');
    }

    const parsedLength = data.length;
    console.log(`[processCalendar] requestedDays=${targetDays} parsedLength=${parsedLength}`);

    const contentTypeFallback = ['Reel', 'Carousel', 'Story', 'Static Image', 'Meme'];
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const toneSafe = (tone && String(tone).trim()) ? String(tone).trim() : 'Balanced';
    const goalSafe = (goal && String(goal).trim()) ? String(goal).trim() : 'engagement';

    const normalizeItem = (raw, index) => {
      const item = raw && typeof raw === 'object' ? raw : {};
      const dayIndex = index + 1;
      const caption = String(item.caption ?? item.text ?? '').trim();
      let hashtags = item.hashtags ?? item.hashtag_set ?? [];
      if (!Array.isArray(hashtags)) {
        if (typeof hashtags === 'string') {
          hashtags = hashtags.split(/\s+/).filter(Boolean);
        } else {
          hashtags = [];
        }
      }
      if (hashtags.length === 0) {
        hashtags = ['#instagram', '#content', '#creator'];
      }
      return {
        day: item.day ?? dayIndex,
        day_of_week: item.day_of_week ?? dayNames[index % dayNames.length],
        content_type: item.content_type ?? item.post_type ?? contentTypeFallback[index % contentTypeFallback.length],
        hook: String(item.hook ?? `Day ${dayIndex}: ${topic} idea`).trim(),
        caption: caption || `${topic} content plan for day ${dayIndex}.`,
        hashtags: hashtags,
        hashtag_set: Array.isArray(item.hashtag_set) ? item.hashtag_set : hashtags,
        best_post_time: String(item.best_post_time ?? item.best_posting_time ?? '7:00 PM IST'),
        content_brief: String(item.content_brief ?? item.creative_brief ?? `${toneSafe} post focused on ${topic}.`).trim(),
        viral_angle: String(item.viral_angle ?? `Designed for ${goalSafe} with a clear niche hook.`).trim(),
        cta: String(item.cta ?? 'Save and share if this helps!').trim(),
      };
    };

    let normalized = data.map((item, idx) => normalizeItem(item, idx));
    if (normalized.length > targetDays) {
      normalized = normalized.slice(0, targetDays);
    } else if (normalized.length < targetDays) {
      const seedItem = normalized.length > 0 ? normalized[normalized.length - 1] : null;
      for (let i = normalized.length; i < targetDays; i++) {
        const fallback = normalizeItem(seedItem || {}, i);
        fallback.day = i + 1;
        fallback.day_of_week = dayNames[i % dayNames.length];
        fallback.hook = `Day ${i + 1}: ${topic} content angle`;
        fallback.caption = `${topic} content for day ${i + 1} (${toneSafe.toLowerCase()} tone, ${goalSafe} goal).`;
        fallback.content_brief = `Create a ${fallback.content_type.toLowerCase()} around ${topic} with a ${toneSafe.toLowerCase()} style.`;
        fallback.viral_angle = `Optimized for ${goalSafe} and consistency in your ${targetDays}-day plan.`;
        fallback.hashtags = [`#${topic.toString().replace(/\s+/g, '').toLowerCase()}`, '#instagramtips', '#creator'];
        fallback.hashtag_set = fallback.hashtags;
        normalized.push(fallback);
      }
    }

    const advice = await buildAdvisor(
      'calendar',
      { topic, days: targetDays, tone: toneSafe, goal: goalSafe },
      normalized.slice(0, 3)
    );
    if (normalized.length > 0) {
      normalized[0] = { ...normalized[0], ai_advice: advice };
    }
    console.log(`[processCalendar] finalLength=${normalized.length} (requested=${targetDays})`);
    completeJobAndRecordUsage(jobId, 'completed', { data: normalized });
    console.log(`[processCalendar] ✅ Job ${jobId} completed successfully, data items: ${normalized.length}`);
  } catch (error) {
    console.error(`[processCalendar] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processCalendar] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: [], 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/calendar
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function generateCalendar(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/calendar' }));
  const body = req.body || {};
  const topic = (body.topic != null ? String(body.topic) : 'instagram growth') || 'instagram growth';
  const rawDays = body.days != null ? parseInt(body.days, 10) : 7;
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 7, 1), 30);
  const tone = body.tone != null ? String(body.tone).trim() : '';
  const goal = body.goal != null ? String(body.goal).trim() : '';
  
  // Generate unique job ID
  const jobId = generateJobId('CALENDAR');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'calendar',
    uid: req.uid,
    topic: topic.trim(),
    days,
    tone: tone || undefined,
    goal: goal || undefined,
  });
  
  console.log(`[generateCalendar] ===== NEW ASYNC REQUEST =====`);
  console.log(`[generateCalendar] Job ID: ${jobId}`);
  console.log(`[generateCalendar] Topic: ${topic}, Days: ${days}, tone: ${tone || '(default)'}, goal: ${goal || '(default)'}`);
  
  // Start background processing (non-blocking)
  processCalendar(jobId, topic.trim(), days, tone, goal)
    .catch((error) => {
      console.error(`[generateCalendar] Background processing failed for job ${jobId}:`, error);
      // On failure, store fallback result
      completeJobAndRecordUsage(jobId, 'done', { 
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
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const uniquePrompt = `${strategyPrompt(niche)}\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}`;
    
    console.log('[processStrategy] Calling Gemini API with unique prompt...');
    const output = await runGemini(uniquePrompt, { 
      maxTokens: 4096, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processStrategy] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    let data = tryParseJson(output, {});
    
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      throw new Error('Invalid strategy data from Gemini API');
    }
    
    const advice = await buildAdvisor('strategy', { niche }, data);
    data.ai_advice = advice;
    completeJobAndRecordUsage(jobId, 'done', { data });
    console.log(`[processStrategy] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processStrategy] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processStrategy] Error stack:`, error.stack);
    completeJobAndRecordUsage(jobId, 'done', { data: {}, error: error.message || 'AI generation failed' });
  }
}

/**
 * POST /ai/strategy
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function generateStrategy(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/strategy' }));
  const { niche = 'instagram growth' } = req.body || {};
  
  // Generate unique job ID
  const jobId = generateJobId('STRATEGY');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'strategy',
    uid: req.uid,
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
      completeJobAndRecordUsage(jobId, 'done', { 
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
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const uniquePrompt = `${nicheAnalysisPrompt(topic)}\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}`;
    
    console.log('[processNicheAnalysis] Calling Gemini API with unique prompt...');
    const output = await runGemini(uniquePrompt, { 
      maxTokens: 4096, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processNicheAnalysis] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    let data = tryParseJson(output, {});
    
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      throw new Error('Invalid analysis data from Gemini API');
    }
    
    completeJobAndRecordUsage(jobId, 'done', { data });
    console.log(`[processNicheAnalysis] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processNicheAnalysis] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processNicheAnalysis] Error stack:`, error.stack);
    completeJobAndRecordUsage(jobId, 'done', { data: {}, error: error.message || 'AI generation failed' });
  }
}

/**
 * POST /ai/analyze
 * Non-blocking endpoint - returns jobId immediately, processes in background
 */
async function analyzeNiche(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/analyze' }));
  const { topic = 'instagram growth' } = req.body || {};
  
  // Generate unique job ID
  const jobId = generateJobId('ANALYZE');
  
  // Create job with pending status
  createJob(jobId, {
    type: 'analyze',
    uid: req.uid,
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
      completeJobAndRecordUsage(jobId, 'done', { 
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
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/image-captions' }));
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
    if (req.uid) recordAiUsage(req.uid, null, req.idempotencyKey, { endpoint: req._aiEndpoint || req.path || (req.baseUrl ? req.baseUrl + (req.path || '') : '') });
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
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/caption-from-media' }));
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
    console.log('[generateCaptionFromMedia] Single-pass Vision: analyze image + write captions...');
    const processStartTime = Date.now();

    // Optimize the image for the Vision API.
    const processedImage = await processImageForGemini(imageBase64, imageMimeType);
    console.log(`[generateCaptionFromMedia] ✅ Image processed: ${processedImage.sizeKB} KB`);

    // ONE Vision call that actually looks at the photo and writes captions that
    // reference what's really in it — far more specific than the old
    // attributes-only path (which threw the image away before writing captions).
    const output = await runGeminiWithImage(
      imageCaptionPrompt(),
      processedImage.base64,
      processedImage.mimeType,
      { maxTokens: 1200, temperature: 0.85, topP: 0.9 }
    );

    console.log('[generateCaptionFromMedia] Vision output length:', (output || '').length);
    const parsed = tryParseJson(output, { analysis: {}, captions: [] });
    const a = parsed.analysis || {};
    const data = {
      analysis: {
        scene: a.scene || 'not clearly visible',
        setting: a.setting || '',
        mood: a.mood || '',
        time: a.time || '',
        occasion: a.occasion || '',
      },
      captions: Array.isArray(parsed.captions) ? parsed.captions : [],
    };

    // Safety net 1: if the Vision call returned no captions, fall back to the
    // text-only generator using the extracted vibe so the user still gets output.
    if (data.captions.length === 0) {
      console.warn('[generateCaptionFromMedia] Vision returned no captions — using text fallback');
      const fb = tryParseJson(
        await runGemini(
          captionGenerationPrompt(data.analysis.scene, data.analysis.setting, data.analysis.mood, data.analysis.time, data.analysis.occasion),
          { maxTokens: 1024, temperature: 0.8 }
        ),
        { captions: [] }
      );
      if (Array.isArray(fb.captions)) data.captions = fb.captions;
    }

    // Safety net 2 (guaranteed non-empty): if BOTH AI attempts failed — e.g. the
    // model refused on a watermarked/text-heavy image — return curated captions
    // so the user never sees an empty screen.
    if (!Array.isArray(data.captions) || data.captions.length === 0) {
      console.warn('[generateCaptionFromMedia] No captions from AI — using curated fallback');
      data.captions = getFallbackCaptions('English', '');
    }

    const totalDuration = Date.now() - processStartTime;
    console.log(`[generateCaptionFromMedia] ✅ Total processing time: ${totalDuration}ms`);
    console.log(`[generateCaptionFromMedia] Generated ${data.captions.length} captions`);
    if (req.uid) recordAiUsage(req.uid, null, req.idempotencyKey, { endpoint: req._aiEndpoint || req.path || (req.baseUrl ? req.baseUrl + (req.path || '') : '') });
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
  
  // NEW FORMAT: Plain text without headings - parse naturally
  // Try to extract from new format: HOOK, BODY, CTA (for backward compatibility)
  const hookMatch = text.match(/HOOK\s*\([^)]+\)\s*:?\s*\n([^\n]+(?:\n[^\n]+)?)/i);
  const bodyMatch = text.match(/BODY\s*:?\s*\n([\s\S]*?)(?=\nCTA\s*:|\n*$)/i);
  const ctaMatch = text.match(/CTA\s*:?\s*\n([^\n]+(?:\n[^\n]+)?)/i);
  
  if (hookMatch && bodyMatch && ctaMatch) {
    const hook = hookMatch[1].trim();
    const body = bodyMatch[1].trim();
    const cta = ctaMatch[1].trim();
    
    // Split body into scenes (by lines or natural breaks)
    const bodyLines = body.split('\n').filter(line => line.trim().length > 0);
    
    // Create script structure
    const script = [];
    
    // Add hook as first scene
    script.push({
      scene: 'Hook',
      duration: '0-3s',
      shot: 'Close-up selfie',
      voiceover: hook,
      on_screen_text: hook.substring(0, 50) // First 50 chars as on-screen text
    });
    
    // Add body scenes (split into 3-4 scenes based on content)
    const scenesCount = Math.min(bodyLines.length, 4);
    const linesPerScene = Math.ceil(bodyLines.length / scenesCount);
    
    for (let i = 0; i < scenesCount; i++) {
      const startIdx = i * linesPerScene;
      const endIdx = Math.min(startIdx + linesPerScene, bodyLines.length);
      const sceneLines = bodyLines.slice(startIdx, endIdx);
      const sceneText = sceneLines.join(' ');
      
      if (sceneText.trim().length > 0) {
        script.push({
          scene: i === 0 ? 'Setup' : i === scenesCount - 1 ? 'Value' : 'Story',
          duration: `${3 + i * 3}-${3 + (i + 1) * 3}s`,
          shot: i === 0 ? 'Medium shot' : i === scenesCount - 1 ? 'Close-up' : 'Wide shot',
          voiceover: sceneText,
          on_screen_text: sceneText.substring(0, 50)
        });
      }
    }
    
    // Add CTA as last scene
    script.push({
      scene: 'CTA',
      duration: '13-15s',
      shot: 'Selfie',
      voiceover: cta,
      on_screen_text: cta.substring(0, 50)
    });
    
    return {
      hooks: [hook],
      script: script,
      cta: cta,
      caption: `${hook} ${body.substring(0, 100)}...`,
      hashtags: ['#reels', '#viral', '#instagram', '#content', '#trending']
    };
  }
  
  // NEW FORMAT: Plain text lines without headings - parse naturally
  const allLines = text.split('\n').filter(line => line.trim().length > 0);
  
  if (allLines.length >= 3) {
    // First 1-2 lines are likely the hook
    const hook = allLines.slice(0, Math.min(2, allLines.length)).join(' ').trim();
    
    // Last 1-2 lines are likely the CTA
    const cta = allLines.slice(-2).join(' ').trim();
    
    // Middle lines are the body
    const bodyLines = allLines.slice(Math.min(2, allLines.length), -2);
    const body = bodyLines.join(' ').trim();
    
    // Create script structure
    const script = [];
    
    // Add hook as first scene
    if (hook) {
      script.push({
        scene: 'Hook',
        duration: '0-3s',
        shot: 'Close-up selfie',
        voiceover: hook,
        on_screen_text: hook.substring(0, Math.min(50, hook.length))
      });
    }
    
    // Add body scenes (split into 3-4 scenes based on content)
    if (bodyLines.length > 0) {
      const scenesCount = Math.min(bodyLines.length, 4);
      const linesPerScene = Math.ceil(bodyLines.length / scenesCount);
      
      for (let i = 0; i < scenesCount; i++) {
        const startIdx = i * linesPerScene;
        const endIdx = Math.min(startIdx + linesPerScene, bodyLines.length);
        const sceneLines = bodyLines.slice(startIdx, endIdx);
        const sceneText = sceneLines.join(' ');
        
        if (sceneText.trim().length > 0) {
          script.push({
            scene: i === 0 ? 'Setup' : i === scenesCount - 1 ? 'Value' : 'Story',
            duration: `${3 + i * 3}-${3 + (i + 1) * 3}s`,
            shot: i === 0 ? 'Medium shot' : i === scenesCount - 1 ? 'Close-up' : 'Wide shot',
            voiceover: sceneText,
            on_screen_text: sceneText.substring(0, Math.min(50, sceneText.length))
          });
        }
      }
    }
    
    // Add CTA as last scene
    if (cta) {
      script.push({
        scene: 'CTA',
        duration: '13-15s',
        shot: 'Selfie',
        voiceover: cta,
        on_screen_text: cta.substring(0, Math.min(50, cta.length))
      });
    }
    
    return {
      hooks: [hook || allLines[0] || ''],
      script: script,
      cta: cta || allLines[allLines.length - 1] || '',
      caption: `${hook || ''} ${body.substring(0, 100)}...`,
      hashtags: ['#reels', '#viral', '#instagram', '#content', '#trending']
    };
  }
  
  // Fallback: Try old format parsing
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
 * Extract parameters from free-text user input (ChatGPT-style)
 * Uses AI-like intelligence to understand user intent
 */
function extractParamsFromUserInput(userInput) {
  const input = userInput.toLowerCase();
  
  // Extract duration (more flexible matching)
  let duration = '15s';
  if (input.match(/\b(30\s*sec|30s|thirty|30\s*second)\b/)) {
    duration = '30s';
  } else if (input.match(/\b(60\s*sec|60s|sixty|1\s*min|one\s*minute|60\s*second)\b/)) {
    duration = '60s';
  } else if (input.match(/\b(15\s*sec|15s|fifteen|15\s*second|short|quick)\b/)) {
    duration = '15s';
  }
  
  // Extract language (more flexible matching)
  let language = 'English';
  if (input.match(/\b(hinglish|hindi\s*english|mix|mixed)\b/)) {
    language = 'Hinglish';
  } else if (input.match(/\b(hindi|हिंदी)\b/) && !input.includes('hinglish')) {
    language = 'Hindi';
  }
  
  // Extract tone (more comprehensive matching)
  let tone = 'motivational';
  if (input.match(/\b(funny|humor|comedy|joke|hilarious|laugh)\b/)) {
    tone = 'funny';
  } else if (input.match(/\b(motivational|motivate|inspire|inspirational|uplifting|empower)\b/)) {
    tone = 'motivational';
  } else if (input.match(/\b(emotional|feeling|heartfelt|touching|sad|happy|love)\b/)) {
    tone = 'emotional';
  } else if (input.match(/\b(educational|teach|explain|learn|tutorial|how\s*to|tips)\b/)) {
    tone = 'educational';
  } else if (input.match(/\b(story|storytelling|narrative|tale|journey|experience)\b/)) {
    tone = 'storytelling';
  } else if (input.match(/\b(dramatic|bold|confident|attitude|powerful|intense|strong)\b/)) {
    tone = 'dramatic';
  }
  
  // Extract audience (more comprehensive matching)
  let audience = 'general';
  if (input.match(/\b(student|college|school|university|exam|study)\b/)) {
    audience = 'students';
  } else if (input.match(/\b(creator|influencer|content\s*creator|youtuber|tiktoker)\b/)) {
    audience = 'creators';
  } else if (input.match(/\b(business|brand|company|professional|entrepreneur|startup|marketing)\b/)) {
    audience = 'business';
  }
  
  // Extract topic - keep the main content, remove metadata words
  let topic = userInput;
  // Remove duration mentions
  topic = topic.replace(/\b(15s?|30s?|60s?|15\s*sec|30\s*sec|60\s*sec|1\s*min|fifteen|thirty|sixty|short|quick|long)\b/gi, '');
  // Remove language mentions
  topic = topic.replace(/\b(hinglish|hindi|english|in\s*hinglish|in\s*hindi|in\s*english)\b/gi, '');
  // Remove tone mentions
  topic = topic.replace(/\b(funny|motivational|emotional|educational|storytelling|dramatic|bold|confident|casual|formal)\b/gi, '');
  // Remove audience mentions
  topic = topic.replace(/\b(for\s*student|for\s*creator|for\s*business|for\s*brand|for\s*company)\b/gi, '');
  // Remove common action words
  topic = topic.replace(/\b(make|create|generate|write|script|reel|video|about|on|the|a|an)\b/gi, '');
  topic = topic.trim();
  
  // If topic is too short or empty, use original input (cleaned)
  if (!topic || topic.length < 3) {
    // Clean original input but keep more context
    topic = userInput
      .replace(/\b(make|create|generate|write|script|reel)\b/gi, '')
      .trim();
  }
  
  // Final fallback: if still empty, use original input
  if (!topic || topic.length < 3) {
    topic = userInput.trim();
  }
  
  // Limit topic length but keep meaningful content
  if (topic.length > 200) {
    topic = topic.substring(0, 200).trim();
  }
  
  // Ensure topic is never empty
  const finalTopic = topic || userInput.substring(0, 100) || 'Instagram Reel';
  
  return {
    topic: finalTopic,
    duration,
    tone,
    audience,
    language
  };
}

/**
 * Generate reels script prompt (ChatGPT-style with free text input)
 * @param {string} userInput - Free text user input describing the reel
 * @param {object} extractedParams - Extracted parameters {topic, duration, tone, audience, language}
 * @param {string} generationId - Unique generation ID
 * @param {string} creativeSeed - Creative seed for uniqueness
 * @param {boolean} regenerate - Whether this is a regenerate request
 * @returns {string} - Formatted prompt
 */
// Detect an explicitly requested output language from the user's text
// ("in hindi", "hindi mein", Devanagari script, etc.). Returns a clear language
// name for the prompt, or '' to let the model match the input language itself.
function detectRequestedLanguage(userInput) {
  const raw = String(userInput || '');
  const t = raw.toLowerCase();
  if (/[ऀ-ॿ]/.test(raw)) return 'Hindi (Devanagari script)';
  if (/[஀-௿]/.test(raw)) return 'Tamil';
  if (/[ఀ-౿]/.test(raw)) return 'Telugu';
  const langMap = {
    hindi: 'Hindi (Devanagari script)',
    english: 'English',
    hinglish: 'Hinglish (natural Hindi + English mix, Latin script)',
    tamil: 'Tamil',
    telugu: 'Telugu',
    marathi: 'Marathi (Devanagari script)',
    bengali: 'Bengali',
    gujarati: 'Gujarati',
    kannada: 'Kannada',
    malayalam: 'Malayalam',
    punjabi: 'Punjabi',
    urdu: 'Urdu',
    spanish: 'Spanish',
    french: 'French',
    arabic: 'Arabic',
  };
  for (const key of Object.keys(langMap)) {
    const re = new RegExp(`\\b(in|into)\\s+${key}\\b|\\b${key}\\s+(me|mein|mai|language)\\b`, 'i');
    if (re.test(t)) return langMap[key];
  }
  return '';
}

// Detect an explicit hashtag count the user asked for ("10 hashtags",
// "include 10 relevant hashtags"). Returns 0 if none / out of a sane range.
function detectRequestedHashtagCount(userInput) {
  const t = String(userInput || '').toLowerCase();
  const m = t.match(/(\d{1,2})\s*(?:relevant\s+|good\s+|niche\s+|viral\s+|trending\s+|different\s+)?hashtags?\b/)
    || t.match(/hashtags?\s*[:=-]?\s*(\d{1,2})\b/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 3 && n <= 30 ? n : 0;
}

function reelsScriptPromptChatGPT(userInput, extractedParams, generationId, creativeSeed, regenerate) {
  const { topic, duration, tone, audience, language } = extractedParams;
  const durationSeconds = parseInt(duration.replace('s', '')) || 15;
  const hookEnd = Math.min(3, durationSeconds);
  const ctaStart = Math.max(durationSeconds - 3, hookEnd + 2);
  
  const regenerateWarning = regenerate 
    ? `\n\n🚨🚨🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨🚨🚨\n\nCRITICAL: Generate a COMPLETELY FRESH script with:\n- NEW hook angle and approach (different from previous)\n- NEW storytelling structure\n- NEW wording (zero word reuse)\n- NEW CTA style\n- NEW emotional angle\n\nDO NOT reuse ANYTHING from previous generation. Think of this as ChatGPT generating a completely new response.\n\n`
    : '';

  const languageGuidelines = language === 'Hindi' 
    ? 'Write EVERYTHING in pure Hindi (Devanagari script). No English words. Use natural Hindi expressions.'
    : language === 'Hinglish'
    ? 'Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing"). Use conversational Hinglish that feels authentic.'
    : 'Write EVERYTHING in pure English. Use natural, conversational English.';

  const toneGuidelines = {
    'funny': 'Playful, witty, humorous, light-hearted, entertaining, use natural jokes and relatable humor',
    'motivational': 'Inspiring, empowering, action-driven, encouraging, uplifting, goal-oriented',
    'emotional': 'Heartfelt, feeling-based, intimate, tender, passionate, emotionally resonant',
    'educational': 'Informative, clear, value-driven, teaching-focused, practical, helpful',
    'storytelling': 'Narrative-driven, engaging story, relatable characters, plot-driven, immersive',
    'dramatic': 'Intense, powerful, attention-grabbing, high-impact, compelling, strong emotions'
  };

  const audienceGuidelines = {
    'creators': 'Creator-focused, engagement-driven, community-oriented, interactive CTAs (comment, save, share)',
    'business': 'Professional, value-focused, results-oriented, business CTAs (learn more, visit link, get started)',
    'students': 'Student-friendly, relatable, educational, practical CTAs (save for later, share with friends)',
    'general': 'Universal appeal, relatable to everyone, broad CTAs (follow, like, share)'
  };

  // Generate unique variation token
  const variationToken = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${creativeSeed.substring(0, 20)}`;

  // Anti-repetition angles
  const angles = ['story', 'question', 'myth', 'POV', 'mistake', 'truth', 'secret', 'transformation', 'confession', 'challenge'];
  const hookStyles = ['curiosity', 'shock', 'emotion', 'question', 'statement', 'story', 'confession', 'transformation'];
  const ctaVariations = ['comment', 'save', 'share', 'follow', 'DM', 'like', 'bookmark', 'tag', 'try', 'test'];

  // Randomly select angle and style for this generation
  const selectedAngle = angles[Math.floor(Math.random() * angles.length)];
  const selectedHookStyle = hookStyles[Math.floor(Math.random() * hookStyles.length)];
  const selectedCTA = ctaVariations[Math.floor(Math.random() * ctaVariations.length)];

  // Force the output language from the request itself (more reliable than
  // hoping the model spots "in hindi" buried in an English prompt).
  const forcedLang = detectRequestedLanguage(userInput);
  const langDirective = forcedLang
    ? `\n\n⚠️⚠️ OUTPUT LANGUAGE = ${forcedLang.toUpperCase()}. Write the hook, EVERY scene's "say", the cta and the caption ENTIRELY in ${forcedLang}. Do NOT write them in English or any other language. (Hashtags may stay romanized.)`
    : '';

  return `You are an elite Instagram Reels scriptwriter behind viral reels for top creators. You understand retention curves, pattern interrupts, and what makes a viewer watch till the end.${langDirective}

THE #1 RULE — STAY ON TOPIC:
The reel MUST be about EXACTLY what the user asked for below. Do NOT change the topic, do NOT turn it into a generic motivational reel, and do NOT promote or mention any app, brand, product, or service unless the user explicitly names one. If a creator profile is provided above this prompt, use it ONLY to match the creator's tone, niche vocabulary, and hashtag style — NEVER to replace the requested topic. If the request is a list (e.g. "top 5 games"), the script MUST actually walk through those specific items with a real detail for each.

USER REQUEST (this is the topic — obey it literally):
"${userInput}"

Write for a ${durationSeconds}-second reel. Tone: ${tone} (${toneGuidelines[tone.toLowerCase()] || 'engaging and confident'}). Audience: ${audience} (${audienceGuidelines[audience.toLowerCase()] || 'general'}).

LANGUAGE (critical): Detect the language and script the user wrote the request in, and write the ENTIRE output (hook, every scene's "say", cta, caption) in that SAME language and script — e.g. a Hindi (Devanagari) request gets a Hindi script, an English request gets English. If the user explicitly names a language anywhere (e.g. "in Hindi", "in English", "in Tamil", "in Marathi"), use THAT language instead, overriding everything. Never default to English translation. (Hashtags may stay romanized/English.)
Freshness seed (make every generation different, never reuse phrasing): ${creativeSeed}${regenerateWarning}

Return ONLY valid JSON — no markdown, no code fences, no text before or after — in EXACTLY this shape:
{
  "hook": "one scroll-stopping opening line the creator SAYS, <= 14 words",
  "scenes": [
    { "time": "0-3s", "say": "the exact words the creator says out loud", "show": "the VISUAL to put on screen — a shot/b-roll direction, NOT the spoken words" }
  ],
  "cta": "one strong spoken call to action",
  "caption": "a fresh Instagram caption for this reel (2-4 short lines, its own hook + a CTA) — do NOT just paste the script back",
  "hashtags": ["8 to 10 hashtags about the TOPIC, each starting with # and no spaces"]
}

HARD RULES:
- Provide 3 to 5 scenes that together fill the full ${durationSeconds} seconds. For a "top N" request, use roughly one scene per item.
- "say" and "show" MUST be different: "say" = spoken words; "show" = camera/visual instruction (e.g. "fast cuts of gameplay", "creator pointing at the phone", "text overlay: TOP 5"). Never copy the dialogue into "show".
- Sound like a real human creator; short punchy lines; no "Did you know", no "Are you making this mistake".
- hashtags must be about the topic — NEVER turn the raw request sentence into a single hashtag.
- Output JSON ONLY.`;
}

/**
 * Generate reels script prompt (Old format - for backward compatibility)
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
    ? `\n\n🚨🚨🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨🚨🚨\n\nCRITICAL: Generate a COMPLETELY FRESH script with:\n- NEW hook angle and approach (different from previous)\n- NEW storytelling structure\n- NEW wording (zero word reuse)\n- NEW CTA style\n- NEW emotional angle\n\nDO NOT reuse ANYTHING from previous generation. Think of this as ChatGPT generating a completely new response.\n\n`
    : '';

  const languageGuidelines = language === 'Hindi' 
    ? 'Write EVERYTHING in pure Hindi (Devanagari script). No English words. Use natural Hindi expressions.'
    : language === 'Hinglish'
    ? 'Mix Hindi and English naturally (e.g., "Kya baat hai! This is amazing"). Use conversational Hinglish that feels authentic.'
    : 'Write EVERYTHING in pure English. Use natural, conversational English.';

  const toneGuidelines = {
    'funny': 'Playful, witty, humorous, light-hearted, entertaining, use natural jokes and relatable humor',
    'motivational': 'Inspiring, empowering, action-driven, encouraging, uplifting, goal-oriented',
    'emotional': 'Heartfelt, feeling-based, intimate, tender, passionate, emotionally resonant',
    'educational': 'Informative, clear, value-driven, teaching-focused, practical, helpful',
    'storytelling': 'Narrative-driven, engaging story, relatable characters, plot-driven, immersive',
    'dramatic': 'Intense, powerful, attention-grabbing, high-impact, compelling, strong emotions'
  };

  const audienceGuidelines = {
    'creators': 'Creator-focused, engagement-driven, community-oriented, interactive CTAs (comment, save, share)',
    'business': 'Professional, value-focused, results-oriented, business CTAs (learn more, visit link, get started)',
    'students': 'Student-friendly, relatable, educational, practical CTAs (save for later, share with friends)',
    'general': 'Universal appeal, relatable to everyone, broad CTAs (follow, like, share)'
  };

  // Calculate timing based on duration
  const durationSeconds = parseInt(duration.replace('s', '')) || 15;
  const hookEnd = Math.min(3, durationSeconds);
  const ctaStart = Math.max(durationSeconds - 3, hookEnd + 2);

  // Generate unique variation token
  const variationToken = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${creativeSeed.substring(0, 20)}`;

  // Anti-repetition angles
  const angles = ['story', 'question', 'myth', 'POV', 'mistake', 'truth', 'secret', 'transformation', 'confession', 'challenge'];
  const hookStyles = ['curiosity', 'shock', 'emotion', 'question', 'statement', 'story', 'confession', 'transformation'];
  const ctaVariations = ['comment', 'save', 'share', 'follow', 'DM', 'like', 'bookmark', 'tag', 'try', 'test'];

  // Randomly select angle and style for this generation
  const selectedAngle = angles[Math.floor(Math.random() * angles.length)];
  const selectedHookStyle = hookStyles[Math.floor(Math.random() * hookStyles.length)];
  const selectedCTA = ctaVariations[Math.floor(Math.random() * ctaVariations.length)];

  return `You are a professional Instagram Reels script writer.
Generate a COMPLETE, HIGH-QUALITY Instagram Reel script every time.
The output must feel human-written, viral, and never repetitive.

🎲 CREATIVE_SEED: ${creativeSeed}
🆔 REQUEST_ID: ${generationId}
📅 TIMESTAMP: ${Date.now()}
🔄 VARIATION_TOKEN: ${variationToken}
📐 SELECTED_ANGLE: ${selectedAngle}
🎯 HOOK_STYLE: ${selectedHookStyle}
📢 CTA_TYPE: ${selectedCTA}
${regenerateWarning}

CORE RULES (VERY IMPORTANT):
1. NEVER repeat the same hook, structure, or CTA for the same topic.
2. Every generation must feel fresh, creative, and unique.
3. Write like a real content creator, not like an AI.
4. Use short punchy lines suitable for speaking in a reel.
5. Avoid generic lines like "This will change your life" unless creatively rewritten.

USER INPUTS:
- Topic: "${topic}"
- Tone: "${tone}" → ${toneGuidelines[tone.toLowerCase()] || 'Professional and engaging'}
- Language: "${language}" → ${languageGuidelines}
- Duration: "${duration}" (${durationSeconds} seconds)
- Target Audience: "${audience}" → ${audienceGuidelines[audience.toLowerCase()] || 'General audience'}

SCRIPT STRUCTURE (MANDATORY):
Return the script strictly in this format:

HOOK (0-${hookEnd} seconds):
- 1-2 highly scroll-stopping lines
- Use ${selectedHookStyle} style
- Approach: ${selectedAngle}
- Must create curiosity / shock / emotion

BODY (Main Content):
- Clear storytelling or explanation
- Broken into short spoken lines
- Natural pauses
- Emotion + relatability
- Match ${tone} tone perfectly
- Duration: ${hookEnd}-${ctaStart} seconds

CTA (Last ${durationSeconds - ctaStart} seconds):
- Creative call to action
- Type: ${selectedCTA}
- Must be different from previous generations
- Natural and engaging

BONUS RULES:
- Add natural emojis (not too many, 1-3 max)
- Use conversational language
- Match the selected tone perfectly
- If language is Hinglish, mix Hindi + English naturally
- If duration is short (15s), keep lines crisp
- If duration is long (30s+), add depth and storytelling
- Write for ${audience} audience specifically

ANTI-REPETITION LOGIC:
- Change angle every time (using ${selectedAngle} approach)
- Change hook style every generation (using ${selectedHookStyle} style)
- Change CTA wording every generation (using ${selectedCTA} variation)
- Use fresh vocabulary and sentence structures
- Vary emotional intensity and pacing

OUTPUT FORMAT:
Return the complete script in this EXACT format (copy-paste ready):

HOOK (0-${hookEnd}s):
[Your scroll-stopping hook here - 1-2 lines max]

BODY:
[Your main content here - broken into short spoken lines, natural pauses, ${tone} tone]
[Write each line on a new line for clarity]
[Make it feel natural and conversational]

CTA:
[Your creative call to action here - ${selectedCTA} style]

IMPORTANT:
- Return ONLY the script text in the format above
- No explanations before or after
- No markdown formatting (no **, ##, etc.)
- Just clean, readable text that can be directly copied and used
- Make it feel like a real content creator wrote it`;
}


/**
 * Parse the structured reels-script JSON the prompt asks for and map it to the
 * client shape { hook, cta, caption, hashtags, scene_by_scene:[{time,dialogue,
 * visual}], fullScript }. dialogue = spoken ("say"), visual = shot direction
 * ("show") — kept DISTINCT so the app no longer shows "Dikhao" repeating the
 * dialogue. fullScript is built ONCE (hook → dialogues → cta), killing the old
 * triple-duplication.
 */
function parseReelsJson(output) {
  if (!output || typeof output !== 'string') return null;
  const text = output.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
  const str = (v) => (v != null ? String(v).trim() : '');
  const hook = str(parsed.hook);
  const cta = str(parsed.cta);
  const caption = str(parsed.caption);
  const scenesIn = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scene_by_scene = scenesIn
    .map((s, i) => ({
      time: str(s && s.time) || `${i * 3}-${i * 3 + 3}s`,
      dialogue: str(s && (s.say || s.dialogue || s.voiceover)),
      visual: str(s && (s.show || s.visual || s.on_screen_text)),
    }))
    .filter((s) => s.dialogue || s.visual);
  const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
    .map((t) => str(t))
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, '')))
    .slice(0, 12);

  const spoken = [hook, ...scene_by_scene.map((s) => s.dialogue).filter(Boolean), cta]
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!hook && scene_by_scene.length === 0) return null;
  return {
    hook,
    cta,
    caption: caption || spoken,
    hashtags,
    scene_by_scene,
    fullScript: spoken,
  };
}

/**
 * Background processing function for reels script (handles errors with fallback)
 * Wraps the main processing logic to ensure fallback on any error
 */
async function processReelsScript(jobId, userInput, extractedParams, regenerate, uid) {
  try {
    // Main processing logic (moved inline to avoid duplicate function)
    console.log(`[processReelsScript] Starting background processing for job: ${jobId}`);
    
    const { topic, duration, tone, audience, language } = extractedParams;
    
    // Generate UNIQUE generationId for EVERY request (especially for regenerate)
    const finalRequestId = `REELS-${Date.now()}-${Math.random()}-${topic.trim().substring(0, Math.min(topic.trim().length, 10))}-${regenerate ? 'REGEN' : 'NEW'}`;
    const generationId = `${Date.now()}-${Math.random()}-${regenerate ? 'REGEN' : 'NEW'}-${Math.random().toString(36).substring(2, 15)}`;
    
    // Generate UNIQUE creative seed
    const creativeSeed = `${uuidv4()}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${Math.random().toString(36).substring(2, 10)}-${finalRequestId.substring(0, Math.min(finalRequestId.length, 20))}`;
    
    console.log(`[processReelsScript] User Input: "${userInput}"`);
    console.log(`[processReelsScript] Extracted - Topic: ${topic}, Duration: ${duration}, Tone: ${tone}, Audience: ${audience}, Language: ${language}`);
    console.log(`[processReelsScript] Regenerate: ${regenerate ? 'YES' : 'NO'}`);
    
    console.log(`[processReelsScript] Job ${jobId} - Calling Gemini API...`);
    // Use ChatGPT-style prompt with free text input
    let prompt = reelsScriptPromptChatGPT(userInput, extractedParams, generationId, creativeSeed, regenerate);

    // Ground the script in the creator's REAL Instagram account when connected.
    // Network-safe: null context = generic prompt (no behavior change for unconnected users).
    try {
      const ctx = await loadCreatorContext(uid);
      const ctxBlock = formatForPrompt(ctx);
      if (ctxBlock) {
        prompt = `${ctxBlock}\n\n${prompt}`;
        console.log(`[processReelsScript] Job ${jobId} - injected real creator context (${ctx.sampleCount} posts analyzed)`);
      }
    } catch (e) {
      console.warn(`[processReelsScript] creator context skipped: ${e.message}`);
    }

    console.log(`[processReelsScript] Job ${jobId} - Prompt length: ${prompt.length} characters`);
    console.log(`[processReelsScript] Job ${jobId} - Using model: ${process.env.GEMINI_MODEL || 'gemini-3-flash-preview'}`);
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Number(process.hrtime.bigint() % 1000000n) + Math.floor(Math.random() * 1000000);
    
    console.log(`[processReelsScript] Unique Seed: ${uniqueSeed}`);
    
    // DEBUG: Log the exact prompt being sent to Gemini
    console.log(`[processReelsScript] 📤 PROMPT SENT TO GEMINI (first 500 chars):`);
    console.log(prompt.substring(0, 500));
    console.log(`[processReelsScript] 📤 Full prompt length: ${prompt.length} characters`);
    
    const output = await runGemini(prompt, {
      maxTokens: 2048,
      temperature: 0.9,
      topP: 1,
      topK: 40,
      randomSeed: uniqueSeed
    });
    
    // DEBUG: Log the exact response received from Gemini
    console.log(`[processReelsScript] 📥 RESPONSE RECEIVED FROM GEMINI (first 500 chars):`);
    console.log(output ? output.substring(0, 500) : 'NULL');
    console.log(`[processReelsScript] 📥 Full response length: ${output?.length || 0} characters`);
    
    console.log(`[processReelsScript] Job ${jobId} - ✅ Gemini API success, response length: ${output?.length || 0}`);
    
    // Parse the structured JSON the prompt asks for. This is what stopped the
    // duplicated sections, "show" copying "say", and the raw-prompt hashtag.
    const transformedData = parseReelsJson(output);
    if (!transformedData || !Array.isArray(transformedData.scene_by_scene) || transformedData.scene_by_scene.length === 0) {
      throw new Error('Failed to parse reels script JSON from Gemini response.');
    }
    console.log(`[processReelsScript] ✅ Parsed ${transformedData.scene_by_scene.length} scenes, ${transformedData.hashtags.length} hashtags`);

    // Update job with completed status and data
    completeJobAndRecordUsage(jobId, 'completed', { data: transformedData });
    console.log(`[processReelsScript] ✅ Job ${jobId} status: processing → completed`);
  } catch (error) {
    console.error(`[processReelsScript] ❌ Job ${jobId} error:`, error.message);
    console.error(`[processReelsScript] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: null,
      error: error.message || 'AI generation failed - Gemini API error'
    });
    throw error;
  }
}

/**
 * Generate full script text in readable format (like ChatGPT)
 */
function generateFullScriptText(transformedData, rawOutput, language) {
  try {
    // NEW FORMAT: If raw output is plain text without headings, use it directly
    if (rawOutput && typeof rawOutput === 'string') {
      // Check if it has headings (old format)
      const hasHeadings = /HOOK|BODY|CTA/i.test(rawOutput);
      
      if (!hasHeadings) {
        // New format: plain text lines - return as is (natural flow)
        return rawOutput.trim();
      }
      
      // Old format: extract from headings (for backward compatibility)
      const hookMatch = rawOutput.match(/HOOK\s*\([^)]+\)\s*:?\s*\n([^\n]+(?:\n[^\n]+)?)/i);
      const bodyMatch = rawOutput.match(/BODY\s*:?\s*\n([\s\S]*?)(?=\nCTA\s*:|\n*$)/i);
      const ctaMatch = rawOutput.match(/CTA\s*:?\s*\n([^\n]+(?:\n[^\n]+)?)/i);
      
      if (hookMatch && bodyMatch && ctaMatch) {
        const hook = hookMatch[1].trim();
        const body = bodyMatch[1].trim();
        const cta = ctaMatch[1].trim();
        
        // Format as natural flow (no headings)
        return `${hook}\n\n${body}\n\n${cta}`;
      }
    }
    
    // Fallback: Build from structured data - NATURAL FLOW (NO HEADINGS)
    let fullScript = '';
    
    // Add Hook (first line, no heading)
    if (transformedData.hook) {
      fullScript += transformedData.hook.trim();
    }
    
    // Add Scene by Scene (natural flow, no headings or timestamps)
    if (transformedData.scene_by_scene && Array.isArray(transformedData.scene_by_scene)) {
      transformedData.scene_by_scene.forEach((scene, index) => {
        if (scene.dialogue && scene.dialogue.trim()) {
          if (fullScript) fullScript += '\n\n';
          fullScript += scene.dialogue.trim();
        }
      });
    }
    
    // Add CTA (last line, no heading)
    if (transformedData.cta) {
      if (fullScript) fullScript += '\n\n';
      fullScript += transformedData.cta.trim();
    }
    
    // If still empty, create a basic natural flow
    if (!fullScript || fullScript.trim().length === 0) {
      const hook = transformedData.hook || 'Let me share something important with you.';
      const scenes = (transformedData.scene_by_scene || []).map(s => s.dialogue).filter(d => d && d.trim());
      const cta = transformedData.cta || 'Save this if it helped you.';
      
      fullScript = hook;
      if (scenes.length > 0) {
        fullScript += '\n\n' + scenes.join('\n\n');
      }
      fullScript += '\n\n' + cta;
    }
    
    return fullScript.trim();
  } catch (error) {
    console.error('[generateFullScriptText] Error:', error);
    // Return basic natural flow if error (NO HEADINGS)
    const hook = transformedData.hook || 'Let me share something important with you.';
    const scenes = (transformedData.scene_by_scene || []).map(s => s.dialogue).filter(d => d && d.trim());
    const cta = transformedData.cta || 'Save this if it helped you.';
    
    let errorScript = hook;
    if (scenes.length > 0) {
      errorScript += '\n\n' + scenes.join('\n\n');
    }
    errorScript += '\n\n' + cta;
    
    return errorScript.trim();
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
  
  // Extract scenes and transform to scene_by_scene format
  const scenes = Array.isArray(scriptData.script) ? scriptData.script : [];
  const durationSeconds = parseInt(duration) || 15;
  
  // Transform scenes to scene_by_scene format: { time, visual, dialogue }
  const sceneByScene = scenes.map((scene, index) => {
    const totalScenes = scenes.length;
    const startTime = Math.floor((index * durationSeconds) / totalScenes);
    const endTime = Math.floor(((index + 1) * durationSeconds) / totalScenes);
    
    return {
      time: `${startTime}-${endTime}s`,
      visual: scene.on_screen_text || scene.visual || scene.shot || (language === 'Hindi' ? 'कैमरा शॉट' : 'Medium shot'),
      dialogue: scene.voiceover || scene.dialogue || scene.text || ''
    };
  });
  
  // If no scenes, create default scene_by_scene
  const finalSceneByScene = sceneByScene.length > 0 ? sceneByScene : [{
    time: '0-3s',
    visual: language === 'Hindi' ? 'कैमरा शॉट' : 'Medium shot',
    dialogue: hook
  }];
  
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
    scene_by_scene: finalSceneByScene,
    cta,
    caption,
    hashtags
  };
}

function buildReelsFallback(topic = 'Instagram growth') {
  return {
    hook: 'Stop scrolling! This will boost your Instagram 🚀',
    scene_by_scene: [
      { time: '0-3s', visual: 'Show your app interface', dialogue: 'Show your app interface' },
      { time: '3-7s', visual: 'Explain problem users face', dialogue: 'Explain problem users face' },
      { time: '7-11s', visual: 'Show how your app solves it', dialogue: 'Show how your app solves it' },
      { time: '11-14s', visual: 'Add quick tip', dialogue: 'Add quick tip' },
      { time: '14-15s', visual: 'Call to action', dialogue: 'Call to action' },
    ],
    cta: 'Follow for more growth hacks 🔥',
    caption: `Grow faster with smart tools 💡 ${topic}`.trim(),
    hashtags: ['#instagrowth', '#reels', '#viral'],
    fullScript:
      'Stop scrolling! This will boost your Instagram.\n\nShow your app interface.\nExplain problem users face.\nShow how your app solves it.\nAdd quick tip.\n\nFollow for more growth hacks.',
  };
}

/**
 * POST /ai/reels-script
 * Non-blocking async endpoint - returns jobId immediately, processes in background
 * NEVER blocks the request, always returns jobId within 2 seconds
 * 
 * Input: { topic, duration, tone, audience, language, regenerate }
 * Output: { success: true, jobId: string }
 * 
 * Job processing happens in background via processReelsScript()
 * Frontend polls GET /ai/job-status/:jobId for completion
 */
async function generateReelsScript(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/reels-script' }));
  console.log('📥 Incoming reels script request:', req.body);
  // Accept either old format (topic, duration, etc.) or new format (userInput)
  const { userInput, topic, duration, tone, audience, language, regenerate = false } = req.body || {};
  
  // If userInput is provided, use new ChatGPT-style approach
  // Otherwise, fall back to old format for backward compatibility
  let finalUserInput = '';
  let extractedParams = {
    topic: '',
    duration: '15s',
    tone: 'motivational',
    audience: 'general',
    language: 'English'
  };
  
  if (userInput && userInput.trim() !== '') {
    // New ChatGPT-style: Extract parameters from free text
    finalUserInput = userInput.trim();
    extractedParams = extractParamsFromUserInput(finalUserInput);
    // Ensure topic is never empty after extraction
    if (!extractedParams.topic || extractedParams.topic.trim() === '') {
      extractedParams.topic = finalUserInput.substring(0, 100);
    }
  } else if (topic && topic.trim() !== '') {
    // Old format: Use provided parameters
    finalUserInput = topic.trim();
    extractedParams = {
      topic: topic.trim(),
      duration: duration || '15s',
      tone: tone || 'motivational',
      audience: audience || 'general',
      language: language || 'English'
    };
  } else {
    return res.status(400).json({ success: false, error: 'Please provide either userInput or topic', data: {} });
  }
  
  // Final safety check: Ensure topic is never empty
  if (!extractedParams.topic || extractedParams.topic.trim() === '') {
    extractedParams.topic = finalUserInput || 'Instagram Reel';
  }
  
  // Validate duration (15s, 30s, 60s only)
  const validDurations = ['15s', '30s', '60s'];
  const finalDuration = validDurations.includes(extractedParams.duration) ? extractedParams.duration : '15s';
  
  // Generate unique job ID
  const jobId = generateJobId('REELS');
  
  console.log(`[generateReelsScript] ==========================================`);
  console.log(`[generateReelsScript] NEW REQUEST - Job ${jobId}`);
  console.log(`[generateReelsScript] User Input: "${finalUserInput}"`);
  console.log(`[generateReelsScript] Extracted - Topic: "${extractedParams.topic}", Duration: ${finalDuration}, Tone: ${extractedParams.tone}, Audience: ${extractedParams.audience}, Language: ${extractedParams.language}`);
  console.log(`[generateReelsScript] ==========================================`);
  
  // Create job with queued status in jobStore
  createJob(jobId, {
    type: 'reels-script',
    uid: req.uid,
    status: 'queued',
    userInput: finalUserInput,
    topic: extractedParams.topic,
    duration: finalDuration,
    tone: extractedParams.tone,
    audience: extractedParams.audience,
    language: extractedParams.language,
    regenerate: regenerate
  });
  
  console.log('🚀 Calling AI model...');
  console.log(`[generateReelsScript] 🚀 Starting Gemini API call - waiting for REAL AI response...`);
  
  // Update job status to processing
  updateJob(jobId, 'processing');
  
  // Process with Gemini API (blocking - wait for response)
  processReelsScript(jobId, finalUserInput, extractedParams, regenerate, req.uid)
    .then(() => {
      // Get the completed job data
      const job = getJob(jobId);
      if (job && job.status === 'completed' && job.data) {
        console.log('✅ AI response:', job.data);
        console.log(`[generateReelsScript] ✅ Gemini API succeeded - returning REAL AI data`);
        res.json({
          success: true,
          jobId: jobId,
          data: job.data
        });
      } else {
        throw new Error('Job completed but data is missing');
      }
    })
    .catch(error => {
      console.error(`[generateReelsScript] ❌ Gemini API failed:`, error.message);
      console.error(`[generateReelsScript] Error stack:`, error.stack);

      const fallback = buildReelsFallback(extractedParams.topic || finalUserInput || 'Instagram growth');
      completeJobAndRecordUsage(jobId, 'done', { data: fallback });

      return res.json({
        success: true,
        jobId,
        data: fallback,
      });
    });
}

/**
 * GET /ai/job-status/:jobId
 * Unified endpoint to check status of any async AI job
 * Returns: { success: true, status: 'pending' | 'completed' | 'failed', data?: {...}, error?: string }
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
  
  // Map jobStore status to API status
  let apiStatus = job.status;
  if (job.status === 'queued') {
    apiStatus = 'pending';
  } else if (job.status === 'processing') {
    apiStatus = 'pending';
  } else if (job.status === 'completed') {
    apiStatus = 'completed';
  } else if (job.status === 'failed') {
    apiStatus = 'failed';
  }
  
  // Return job status and data (if completed or failed)
  const response = {
    success: true,
    status: apiStatus, // 'pending' | 'completed' | 'failed'
    jobId: job.jobId || job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  
  // Include data if job is completed or failed (always return data, even if fallback)
  if (job.status === 'completed' || job.status === 'failed') {
    response.data = job.data || job.result || null;
    
    // If no data, provide fallback based on job type
    if (!response.data) {
      switch (job.type) {
        case 'captions':
          response.data = { captions: getFallbackCaptions(job.language || 'English') };
          break;
        case 'calendar':
          response.data = [];
          break;
        case 'strategy':
          response.data = {};
          break;
        case 'reels-script':
          // NO FALLBACK - If job failed, return error
          if (response.status === 'failed' || !response.data) {
            console.log(`[getJobStatus] Job ${jobId} failed or missing data - returning error (NO FALLBACK)`);
            response.status = 'failed';
            response.error = response.error || 'AI generation failed';
            response.data = null;
          }
          break;
        case 'post-ideas':
          response.data = [];
          break;
        case 'hashtags':
          response.data = [];
          break;
        case 'bio':
          response.data = null;
          break;
        case 'hooks':
          response.data = [];
          break;
        case 'comment-reply':
          response.data = null;
          break;
        case 'trends':
          response.data = { hashtags: [], topics: [], ideas: [] };
          break;
        case 'carousel':
          response.data = { title: '', caption: '', slides: [] };
          break;
        default:
          response.data = {};
      }
    }
  }
  
  // Include error message if failed status
  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }
  
  console.log(`[getJobStatus] Job ${jobId} (type: ${job.type}) status: ${apiStatus}`);
  res.json(response);
}

/**
 * POST /ai/post-ideas
 * Generate post ideas using Gemini API
 */
async function generatePostIdeas(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/post-ideas' }));
  const { topic, niche, count = 5, format } = req.body || {};
  const ideaFormat = format === 'story' ? 'story' : 'post';

  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: [] });
  }

  const jobId = generateJobId('POST_IDEAS');

  createJob(jobId, {
    type: 'post-ideas',
    uid: req.uid,
    topic: topic.trim(),
    niche: niche || '',
    count: parseInt(count) || 5,
    format: ideaFormat,
  });

  console.log(`[generatePostIdeas] ===== NEW REQUEST =====`);
  console.log(`[generatePostIdeas] Job ID: ${jobId}`);
  console.log(`[generatePostIdeas] Topic: "${topic}", Niche: "${niche}", Count: ${count}, Format: ${ideaFormat}`);

  processPostIdeas(jobId, topic.trim(), niche || '', parseInt(count) || 5, ideaFormat)
    .catch((error) => {
      console.error(`[generatePostIdeas] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: [],
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generatePostIdeas] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for post ideas generation
 */
async function processPostIdeas(jobId, topic, niche, count, format = 'post') {
  console.log(`[processPostIdeas] Starting background processing for job: ${jobId} (format: ${format})`);

  try {
    updateJob(jobId, 'processing', {});

    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const nicheContext = niche ? ` for ${niche} niche` : '';

    const meta = `\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}`;

    const storyPrompt = `You are an Instagram STORIES expert. You design Story sequences that keep viewers tapping and replying, using native Story features (polls, quizzes, sliders, question/DM stickers, countdowns, "this or that", BTS, teasers).

STEP 1 — ANALYZE SILENTLY (do not output): For "${topic}"${nicheContext}, figure out who watches these Stories, what makes them tap forward vs. actually reply/vote, and which interactive stickers fit best. Match the language if it's Hindi/Hinglish.

STEP 2 — Generate ${count} Instagram STORY ideas (NOT feed posts). Each must be a story a creator can shoot on their phone today, using at least one interactive sticker OR a multi-frame sequence. Vary the types (poll, quiz, question box, countdown, BTS, tutorial-in-frames, slider, "this or that"). Be specific — never "post a poll".

Each idea must include:
- A catchy story-concept title
- A description: exactly how to execute it frame-by-frame and which sticker to use
- The angle (why viewers tap or reply)
- Target audience
- Engagement strategy (how it drives replies / DMs / poll taps)

Return the ideas as a JSON array with this EXACT structure:
[
  {
    "title": "Story idea title",
    "description": "Frame-by-frame execution + sticker to use",
    "angle": "Why viewers tap/reply",
    "audience": "Target audience",
    "engagement": "Engagement strategy"
  }
]${meta}`;

    const postPrompt = `You are a viral content ideator for Instagram. You come up with post ideas that creators can't wait to film because they know they'll perform.

STEP 1 — ANALYZE SILENTLY (do not output): For the topic${nicheContext} "${topic}", identify the audience, what they're curious about, and the emotions (curiosity, relatability, aspiration) that drive engagement in this niche. Match the language if it's Hindi/Hinglish.

STEP 2 — Generate ${count} post ideas that are SPECIFIC and scroll-worthy (never generic "share a tip"). Vary the format (Reel / carousel / relatable meme / story / tutorial / listicle) and the emotional angle.

Each idea must include:
- A catchy, curiosity-driving title/headline
- A brief description (1-2 sentences)
- The content angle (the hook/format)
- Target audience
- Engagement strategy (how it earns saves/shares/comments)

Return the ideas as a JSON array with this structure:
[
  {
    "title": "Post idea title",
    "description": "Brief description",
    "angle": "Content angle",
    "audience": "Target audience",
    "engagement": "Engagement strategy"
  },
  ...
]${meta}`;

    const prompt = format === 'story' ? storyPrompt : postPrompt;
    
    console.log('[processPostIdeas] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 2048, 
      temperature: 0.9,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processPostIdeas] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    let data = tryParseJson(output, []);
    
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid post ideas data from Gemini API');
    }
    
    // Ensure we have the requested count
    data = data.slice(0, count);
    
    completeJobAndRecordUsage(jobId, 'completed', { data });
    console.log(`[processPostIdeas] ✅ Job ${jobId} completed successfully, ideas: ${data.length}`);
  } catch (error) {
    console.error(`[processPostIdeas] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processPostIdeas] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: [], 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/hashtags
 * Generate hashtags using Gemini API
 */
async function generateHashtags(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/hashtags' }));
  const { topic, caption, count = 20 } = req.body || {};
  
  if (!topic && !caption) {
    return res.status(400).json({ success: false, error: 'Topic or caption is required', data: [] });
  }
  
  const jobId = generateJobId('HASHTAGS');
  
  createJob(jobId, {
    type: 'hashtags',
    uid: req.uid,
    topic: topic || '',
    caption: caption || '',
    count: parseInt(count) || 20,
  });
  
  console.log(`[generateHashtags] ===== NEW REQUEST =====`);
  console.log(`[generateHashtags] Job ID: ${jobId}`);
  console.log(`[generateHashtags] Topic: "${topic}", Caption: "${caption?.substring(0, 50)}...", Count: ${count}`);
  
  processHashtags(jobId, topic || '', caption || '', parseInt(count) || 20)
    .catch((error) => {
      console.error(`[generateHashtags] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: [],
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateHashtags] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for hashtags generation
 */
async function processHashtags(jobId, topic, caption, count) {
  console.log(`[processHashtags] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    
    const context = caption ? `Caption: "${caption}"` : `Topic: "${topic}"`;
    const forcedLang = detectRequestedLanguage(topic || caption || '');
    const langLine = forcedLang
      ? `- Write/transliterate tags to suit ${forcedLang} content (tags themselves may stay romanized).`
      : '- If the topic is written in Hindi/Hinglish, include tags that fit that audience.';

    const prompt = `You are an Instagram hashtag strategist whose sets are engineered to maximize REACH and DISCOVERY — not just relevance.

STEP 1 — ANALYZE SILENTLY (do not output): From this ${context}, identify the core niche, sub-topics, and the exact audience searching for this content.

STEP 2 — Generate ${count} Instagram hashtags using a REACH-TIER mix (this ranks far better than random popular tags):
- ~20% BIG reach (broad discovery)
- ~40% MEDIUM reach (the sweet spot where a post can actually rank)
- ~30% NICHE (highly targeted, easier to trend in)
- ~10% MICRO / community tags (specific communities)

Rules:
- Every tag must be genuinely relevant to the ${context}.
- The audience is primarily in INDIA — where it fits the topic, include a natural mix of India-relevant and community tags (e.g. #IndianCreators, city/region or niche-in-India tags) alongside global ones. Do not force India tags onto an unrelated topic.
- Specific over generic. AVOID dead/overused tags: #love #instagood #viral #followforfollow #photooftheday #f4f #instadaily.
- No spaces or special characters — Instagram-valid tags only.
${langLine}

Return ONLY a JSON array of exactly ${count} strings:
["#tag1", "#tag2", "#tag3", ...]

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}`;
    
    console.log('[processHashtags] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 1024, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processHashtags] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    let data = tryParseJson(output, []);
    
    if (!Array.isArray(data) || data.length === 0) {
      // Try to extract hashtags from plain text
      const hashtagRegex = /#[\w]+/g;
      const extractedHashtags = output.match(hashtagRegex) || [];
      if (extractedHashtags.length > 0) {
        data = extractedHashtags.slice(0, count);
      } else {
        throw new Error('Invalid hashtags data from Gemini API');
      }
    }
    
    // Ensure we have the requested count
    data = data.slice(0, count);
    
    // Ensure all hashtags start with #
    data = data.map(tag => tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`);
    const advice = await buildAdvisor(
      'hashtags',
      { topic, caption, requestedCount: count },
      { hashtags: data.slice(0, 12) }
    );
    const payload = { hashtags: data, ai_advice: advice };
    completeJobAndRecordUsage(jobId, 'completed', { data: payload });
    console.log(`[processHashtags] ✅ Job ${jobId} completed successfully, hashtags: ${data.length}`);
  } catch (error) {
    console.error(`[processHashtags] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processHashtags] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: [], 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/bio
 * Generate Instagram bio using Gemini API
 */
async function generateBio(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/bio' }));
  const { description, style = 'short' } = req.body || {};
  
  if (!description || description.trim() === '') {
    return res.status(400).json({ success: false, error: 'Description is required', data: null });
  }
  
  const jobId = generateJobId('BIO');
  
  createJob(jobId, {
    type: 'bio',
    uid: req.uid,
    description: description.trim(),
    style: style,
  });
  
  console.log(`[generateBio] ===== NEW REQUEST =====`);
  console.log(`[generateBio] Job ID: ${jobId}`);
  console.log(`[generateBio] Description: "${description.substring(0, 50)}...", Style: ${style}`);
  
  processBio(jobId, description.trim(), style)
    .catch((error) => {
      console.error(`[generateBio] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: null,
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateBio] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for bio generation
 */
async function processBio(jobId, description, style) {
  console.log(`[processBio] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    
    const styleInstructions = {
      'short': 'Keep it concise (under 150 characters). Make it punchy and memorable.',
      'long': 'Create a detailed bio (200-300 characters). Include more information about the person/brand.',
      'aesthetic': 'Make it visually appealing with emojis and creative formatting. Keep it stylish and modern.'
    };
    
    const styleGuide = styleInstructions[style] || styleInstructions['short'];
    
    const prompt = `You are an Instagram bio expert who crafts bios that turn profile visitors into followers. A great bio instantly answers "who are you, what do I get, why follow you" — with personality.

STEP 1 — ANALYZE SILENTLY (do not output): From "${description}", identify the person/brand's niche, their unique value, target audience, and personality/tone. Detect the language (English/Hindi/Hinglish) and match it.

STEP 2 — Write a bio that:
- Leads with a clear identity (who + what they do)
- States the value/benefit (why someone should follow)
- Shows personality (never robotic)
- Uses short lines + relevant emojis for scannability
- Ends with a subtle CTA if it fits (link, DM, collab)

Style: ${style} — ${styleGuide}

Rules:
- Optimize for Instagram's bio character limit; no wasted words.
- Specific and authentic — never generic ("Living my best life ✨", "Dream big").
- Match the user's language.

Return ONLY the bio text. No explanations, no labels.

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}`;
    
    console.log('[processBio] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 512, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processBio] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    // Clean the output - remove any extra formatting
    let bio = output.trim()
      .replace(/^[•\-*]\s*/gm, '')
      .replace(/^\d+[\.\)]\s*/gm, '')
      .replace(/^Bio:\s*/i, '')
      .replace(/^Instagram Bio:\s*/i, '')
      .trim();
    
    if (bio.length < 10) {
      throw new Error('Invalid bio data from Gemini API - too short');
    }
    
    completeJobAndRecordUsage(jobId, 'completed', { data: bio });
    console.log(`[processBio] ✅ Job ${jobId} completed successfully, bio length: ${bio.length}`);
  } catch (error) {
    console.error(`[processBio] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processBio] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: null, 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/hooks
 * Generate viral hooks using Gemini API
 */
async function generateHooks(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/hooks' }));
  const { topic, count = 5 } = req.body || {};
  
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: null });
  }
  
  const jobId = generateJobId('HOOK');
  
  createJob(jobId, {
    type: 'hooks',
    uid: req.uid,
    topic: topic.trim(),
    count: count,
  });
  
  console.log(`[generateHooks] ===== NEW REQUEST =====`);
  console.log(`[generateHooks] Job ID: ${jobId}`);
  const topicPreview = topic.length > 50 ? `${topic.substring(0, 50)}...` : topic;
  console.log(`[generateHooks] Topic: "${topicPreview}", Count: ${count}`);
  
  processHooks(jobId, topic.trim(), count)
    .catch((error) => {
      console.error(`[generateHooks] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: [],
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateHooks] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for hook generation
 */
async function processHooks(jobId, topic, count) {
  console.log(`[processHooks] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}`;
    
    const prompt = `You are a viral hook writer who has engineered opening lines for reels with tens of millions of views. You know the first 3 words decide whether someone watches or scrolls.

STEP 1 — ANALYZE SILENTLY (do not output): For the topic "${topic}", identify the audience, their curiosity triggers, and the pain or desire that makes them stop. Detect and match the language (English/Hindi/Hinglish).

STEP 2 — Write ${count} scroll-stopping hooks (5-15 words each), each a DIFFERENT angle. Every hook must create an instant "I need to know" — using curiosity gaps, bold claims, relatable pain, surprising numbers, or a POV.

Mix these styles across the set:
1. Question ("What if I told you...")
2. Bold statement ("This changed everything...")
3. Curiosity / contrarian ("The truth nobody tells you...")
4. Personal / relatable ("I used to think...")
5. Number / list ("3 things that...")
6. Story ("Last week I discovered...")

Rules:
- Each hook UNIQUE — different angle and structure.
- BANNED: "Don't miss this", "You won't believe", "Are you making this mistake".
- Match the user's language.

OUTPUT FORMAT:
Return EXACTLY ${count} hooks, each on a separate line starting with "• ". No numbering, no labels, no explanations.

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}
🎲 RANDOM_CONTEXT: ${randomContext}`;
    
    console.log('[processHooks] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 512, 
      temperature: 0.9,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processHooks] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    // Extract hooks from output
    const lines = output.trim().split('\n').filter(line => line.trim().length > 0);
    const hooks = [];
    
    for (const line of lines) {
      // Remove bullet points, numbering, and extra formatting
      let hookText = line
        .replace(/^[•\-*]\s*/, '') // Remove bullet points
        .replace(/^\d+[\.\)]\s*/, '') // Remove numbering
        .replace(/^Hook\s*\d*:?\s*/i, '') // Remove "Hook 1:" etc.
        .trim();
      
      if (hookText.length > 5 && hookText.length < 100) { // Valid hook length
        hooks.push(hookText);
      }
      if (hooks.length >= count) break; // Stop after getting enough hooks
    }
    
    // Ensure we have at least some hooks
    if (hooks.length === 0) {
      throw new Error('No valid hooks extracted from Gemini response');
    }
    
    // Fill remaining slots with variations if needed
    while (hooks.length < count && hooks.length < 10) {
      const baseHook = hooks[hooks.length % hooks.length];
      hooks.push(`${baseHook} (variation ${hooks.length + 1})`);
    }
    
    // Limit to requested count
    const finalHooks = hooks.slice(0, count);
    
    completeJobAndRecordUsage(jobId, 'completed', { data: finalHooks });
    console.log(`[processHooks] ✅ Job ${jobId} completed successfully with ${finalHooks.length} hooks`);
  } catch (error) {
    console.error(`[processHooks] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processHooks] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: [], 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/comment-reply
 * Generate AI reply to a comment using Gemini API
 */
async function generateCommentReply(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/comment-reply' }));
  const { comment, tone = 'friendly', context } = req.body || {};
  const replyContext = context === 'dm' ? 'dm' : 'comment';

  if (!comment || comment.trim() === '') {
    return res.status(400).json({ success: false, error: 'Comment is required', data: null });
  }

  const jobId = generateJobId('REPLY');

  createJob(jobId, {
    type: 'comment-reply',
    uid: req.uid,
    comment: comment.trim(),
    tone: tone,
    context: replyContext,
  });

  console.log(`[generateCommentReply] ===== NEW REQUEST =====`);
  console.log(`[generateCommentReply] Job ID: ${jobId}`);
  const commentPreview = comment.length > 50 ? `${comment.substring(0, 50)}...` : comment;
  console.log(`[generateCommentReply] Comment: "${commentPreview}", Tone: ${tone}, Context: ${replyContext}`);

  processCommentReply(jobId, comment.trim(), tone, replyContext)
    .catch((error) => {
      console.error(`[generateCommentReply] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: null,
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateCommentReply] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for comment reply generation
 */
async function processCommentReply(jobId, comment, tone, context = 'comment') {
  console.log(`[processCommentReply] Starting background processing for job: ${jobId} (context: ${context})`);

  try {
    updateJob(jobId, 'processing', {});

    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}`;

    const toneInstructions = {
      'friendly': 'Be warm, friendly, and approachable. Use casual language.',
      'professional': 'Be formal, polite, and business-like. Use professional language.',
      'funny': 'Be humorous, witty, and light-hearted. Add humor where appropriate.',
      'empathetic': 'Be understanding, supportive, and compassionate. Show empathy.',
      'brief': 'Be concise and to the point. Keep it short and clear.',
      'enthusiastic': 'Be energetic, positive, and excited. Show enthusiasm.'
    };

    const toneGuide = toneInstructions[tone] || toneInstructions['friendly'];

    const meta = `\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}\n🎲 RANDOM_CONTEXT: ${randomContext}`;

    const dmPrompt = `You are a top Instagram creator personally replying to a DM. Your replies feel 1:1 and human, protect your time, and turn DMs into opportunities.

STEP 1 — ANALYZE SILENTLY (do not output): Read the DM "${comment}" and classify it: fan/appreciation, a question (price / how-to), a collab or brand deal, a sales/promo pitch, or spam/inappropriate. Detect the sender's language (English/Hindi/Hinglish) and their real intent.

STEP 2 — Write ONE reply tuned to the type:
- Fan/appreciation → warm, personal thanks + a light question to keep the chat going
- Question (price/how-to) → answer clearly; if it's about paid work, sound professional and invite the next step
- Collab/brand deal → interested but professional; ask for details (deliverables, timeline, budget) without sounding desperate
- Sales/spam/inappropriate → a short, polite boundary or decline

Tone: ${tone} — ${toneGuide}

Rules:
- 1-3 sentences, sounds like a real person typing — never a template.
- Match the sender's language. 0-2 natural emojis.
- Return ONLY the DM reply text. No labels, no "Here is your reply".${meta}`;

    const commentPrompt = `You are a community manager for a top Instagram creator. Your replies build loyal fans — they feel personal, keep the conversation going, and boost engagement (replies count as engagement).

STEP 1 — ANALYZE SILENTLY (do not output): Read the comment "${comment}" — is it praise, a question, criticism, or just emoji/spam? What's the commenter's intent and emotion? Detect and match their language (English/Hindi/Hinglish).

STEP 2 — Write ONE reply that:
- Feels personal and human (never templated)
- Praise → warmly acknowledge + a small hook to reply again
- Question → actually answer it, helpfully
- Criticism → stay classy, diplomatic, helpful (never defensive)
- Encourages further interaction naturally

Tone: ${tone} — ${toneGuide}

Rules:
- 1-2 sentences, concise. 1-2 natural emojis max.
- Match the commenter's language.
- Never robotic or generic ("Thanks for your comment!").

Return ONLY the reply text. No explanations, no labels.${meta}`;

    const prompt = context === 'dm' ? dmPrompt : commentPrompt;
    
    console.log('[processCommentReply] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 256, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processCommentReply] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    // Clean the output - remove any extra formatting
    let reply = output.trim()
      .replace(/^[•\-*]\s*/gm, '')
      .replace(/^\d+[\.\)]\s*/gm, '')
      .replace(/^Reply:\s*/i, '')
      .replace(/^Comment Reply:\s*/i, '')
      .replace(/^Response:\s*/i, '')
      .trim();
    
    if (reply.length < 5) {
      throw new Error('Invalid reply data from Gemini API - too short');
    }
    
    completeJobAndRecordUsage(jobId, 'completed', { data: reply });
    console.log(`[processCommentReply] ✅ Job ${jobId} completed successfully, reply length: ${reply.length}`);
  } catch (error) {
    console.error(`[processCommentReply] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processCommentReply] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: null, 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * POST /ai/trends
 * Get trending topics, hashtags, and content ideas using Gemini API
 */
async function generateTrends(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/trends' }));
  const { niche, category = 'All' } = req.body || {};
  
  const jobId = generateJobId('TREND');
  
  createJob(jobId, {
    type: 'trends',
    uid: req.uid,
    niche: niche || category,
    category: category,
  });
  
  console.log(`[generateTrends] ===== NEW REQUEST =====`);
  console.log(`[generateTrends] Job ID: ${jobId}`);
  console.log(`[generateTrends] Niche: "${niche || 'All'}", Category: ${category}`);
  
  processTrends(jobId, niche || category, category)
    .catch((error) => {
      console.error(`[generateTrends] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: { hashtags: [], topics: [], ideas: [] },
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateTrends] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for trends generation
 */
async function processTrends(jobId, niche, category) {
  console.log(`[processTrends] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}`;
    
    const nicheContext = niche && niche !== 'All' ? `Focus on ${niche} niche specifically.` : 'Cover all popular niches and general trends.';
    
    const prompt = `Generate current trending content for Instagram in ${category === 'All' ? 'all categories' : category} niche.

${nicheContext}

CRITICAL REQUIREMENTS:
- Provide REAL, CURRENT trending topics (as of ${new Date().toLocaleDateString()})
- Include trending hashtags that are actually being used right now
- Suggest trending content ideas that creators are posting
- Focus on what's viral and engaging on Instagram Reels and Posts
- Include mix of general trends and niche-specific trends
- Make it relevant to current events, seasons, and social media culture

OUTPUT FORMAT (JSON):
{
  "hashtags": ["#trending1", "#trending2", "#trending3", ...],
  "topics": ["Trending topic 1", "Trending topic 2", "Trending topic 3", ...],
  "ideas": ["Content idea 1", "Content idea 2", "Content idea 3", ...]
}

Return EXACTLY 20 trending hashtags, 10 trending topics, and 10 content ideas.
All should be CURRENT and RELEVANT to Instagram trends.

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}
🎲 RANDOM_CONTEXT: ${randomContext}`;
    
    console.log('[processTrends] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 1024, 
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processTrends] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    // Try to parse JSON from output
    let trendsData = null;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = output.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        trendsData = JSON.parse(jsonMatch[1]);
      } else {
        // Try direct JSON parse
        trendsData = JSON.parse(output.trim());
      }
    } catch (parseError) {
      // If JSON parsing fails, extract from text
      console.log('[processTrends] JSON parsing failed, extracting from text...');
      trendsData = extractTrendsFromText(output);
    }
    
    if (!trendsData || !trendsData.hashtags || !Array.isArray(trendsData.hashtags)) {
      throw new Error('Invalid trends data from Gemini API');
    }
    
    // Ensure all hashtags start with #
    trendsData.hashtags = trendsData.hashtags.map(tag => 
      tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`
    );
    
    // Ensure we have arrays
    trendsData.topics = trendsData.topics || [];
    trendsData.ideas = trendsData.ideas || [];
    trendsData.ai_advice = await buildAdvisor(
      'growth_suggestions',
      { niche, category },
      {
        topics: trendsData.topics.slice(0, 5),
        ideas: trendsData.ideas.slice(0, 5),
      }
    );
    
    completeJobAndRecordUsage(jobId, 'completed', { data: trendsData });
    console.log(`[processTrends] ✅ Job ${jobId} completed successfully - hashtags: ${trendsData.hashtags.length}, topics: ${trendsData.topics.length}, ideas: ${trendsData.ideas.length}`);
  } catch (error) {
    console.error(`[processTrends] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processTrends] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: { hashtags: [], topics: [], ideas: [] }, 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * Extract trends from plain text if JSON parsing fails
 */
function extractTrendsFromText(text) {
  const result = {
    hashtags: [],
    topics: [],
    ideas: []
  };
  
  // Extract hashtags
  const hashtagRegex = /#[\w]+/g;
  const foundHashtags = text.match(hashtagRegex) || [];
  result.hashtags = [...new Set(foundHashtags)].slice(0, 20);
  
  // Extract topics (lines starting with bullet points or numbers)
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const topicLines = lines.filter(line => 
    /^[•\-*\d+\.\)]/.test(line.trim()) && 
    !line.includes('#') &&
    line.trim().length > 10
  );
  result.topics = topicLines.slice(0, 10).map(line => 
    line.replace(/^[•\-*\d+\.\)]\s*/, '').trim()
  );
  
  // Extract ideas (similar to topics)
  result.ideas = topicLines.slice(10, 20).map(line => 
    line.replace(/^[•\-*\d+\.\)]\s*/, '').trim()
  );
  
  return result;
}

/**
 * POST /ai/carousel
 * Generate Instagram carousel post content using Gemini API
 */
async function generateCarousel(req, res) {
  console.log('AI_CONTROLLER_HIT', JSON.stringify({ endpoint: req._aiEndpoint || req.path || req.originalUrl || '/ai/carousel' }));
  const { topic, slides = 5 } = req.body || {};
  
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: null });
  }
  
  const jobId = generateJobId('CAROUSEL');
  
  createJob(jobId, {
    type: 'carousel',
    uid: req.uid,
    topic: topic.trim(),
    slides: slides,
  });
  
  console.log(`[generateCarousel] ===== NEW REQUEST =====`);
  console.log(`[generateCarousel] Job ID: ${jobId}`);
  const topicPreview = topic.length > 50 ? `${topic.substring(0, 50)}...` : topic;
  console.log(`[generateCarousel] Topic: "${topicPreview}", Slides: ${slides}`);
  
  processCarousel(jobId, topic.trim(), slides)
    .catch((error) => {
      console.error(`[generateCarousel] Background processing failed for job ${jobId}:`, error);
      completeJobAndRecordUsage(jobId, 'done', { 
        data: null,
        error: error.message || 'AI generation failed'
      });
    });
  
  console.log(`[generateCarousel] ✅ Returning jobId immediately: ${jobId}`);
  res.json({ 
    success: true, 
    jobId: jobId
  });
}

/**
 * Background processing for carousel generation
 */
async function processCarousel(jobId, topic, slides) {
  console.log(`[processCarousel] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}`;
    
    const prompt = `You are an Instagram carousel expert. Carousels are the #1 format for SAVES and SHARES — a great one hooks on slide 1, delivers value slide by slide, and ends with a CTA that earns the save.

STEP 1 — ANALYZE SILENTLY (do not output): For "${topic}", identify the audience, the single valuable outcome they want, and the language to match (English/Hindi/Hinglish).

STEP 2 — Build EXACTLY ${slides} slides that flow like a mini-story:
- Slide 1 = a scroll-stopping HOOK title (bold claim / curiosity / "swipe to see...") that forces a swipe.
- Middle slides = one clear, actionable point each (concise, 1-2 lines, skimmable).
- Last slide = a CTA that drives SAVE / SHARE / FOLLOW ("Save this for later", "Share with a friend who needs this").

CRITICAL:
- EXACTLY ${slides} slides, logical progression, no filler.
- Actionable value, not fluff. 1-2 emojis per slide max.
- Match the user's language.

OUTPUT FORMAT (JSON):
{
  "title": "Main title/headline for the carousel",
  "caption": "Instagram caption with hashtags",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Slide 1 title",
      "content": "Slide 1 content text"
    },
    {
      "slideNumber": 2,
      "title": "Slide 2 title",
      "content": "Slide 2 content text"
    }
    ... (${slides} slides total)
  ]
}

Return ONLY valid JSON. No explanations. No markdown code blocks.

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}
🎲 RANDOM_CONTEXT: ${randomContext}`;
    
    // Scale token budget with slide count so higher counts (8-10) don't get
    // their JSON truncated mid-array (which was silently dropping slides).
    const carouselTokens = Math.min(4096, 900 + slides * 320);
    console.log(`[processCarousel] Calling Gemini API (slides: ${slides}, maxTokens: ${carouselTokens})...`);
    const output = await runGemini(prompt, {
      maxTokens: carouselTokens,
      temperature: 0.8,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    console.log('[processCarousel] Gemini response received, length:', output?.length || 0);
    
    if (!output || output.trim().length === 0) {
      throw new Error('Empty response from Gemini API');
    }
    
    // Try to parse JSON from output
    let carouselData = null;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = output.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      if (jsonMatch) {
        carouselData = JSON.parse(jsonMatch[1]);
      } else {
        // Try direct JSON parse
        carouselData = JSON.parse(output.trim());
      }
    } catch (parseError) {
      console.log('[processCarousel] JSON parsing failed, extracting from text...');
      carouselData = extractCarouselFromText(output, slides);
    }
    
    if (!carouselData || !carouselData.slides || !Array.isArray(carouselData.slides)) {
      throw new Error('Invalid carousel data from Gemini API');
    }
    
    // Ensure we have the right number of slides. If the model returned fewer,
    // pad with usable slides (never blank "Additional content" placeholders) so
    // every slide the user asked for has real, postable text.
    if (carouselData.slides.length < slides) {
      const padFillers = [
        { title: 'Quick recap', content: 'Recap the 1 big idea so it sticks — one line, easy to remember.' },
        { title: 'Common mistake', content: 'Call out the #1 mistake people make with this — and the quick fix.' },
        { title: 'Pro tip', content: 'Drop one bonus tip most people miss. Small effort, big result.' },
        { title: 'Your turn', content: 'Give one action to try today. Keep it simple and specific.' },
        { title: 'Save this', content: 'Save this post so you can come back to it — and share it with a friend who needs it. 🔖' },
      ];
      let fi = 0;
      while (carouselData.slides.length < slides) {
        const isLast = carouselData.slides.length === slides - 1;
        const filler = isLast
          ? padFillers[padFillers.length - 1]
          : padFillers[fi % (padFillers.length - 1)];
        carouselData.slides.push({
          slideNumber: carouselData.slides.length + 1,
          title: filler.title,
          content: filler.content,
        });
        fi += 1;
      }
    } else {
      carouselData.slides = carouselData.slides.slice(0, slides);
    }
    
    // Ensure title and caption exist
    if (!carouselData.title) {
      carouselData.title = `Carousel: ${topic}`;
    }
    if (!carouselData.caption) {
      carouselData.caption = `Check out this carousel about ${topic}! 💫`;
    }
    
    completeJobAndRecordUsage(jobId, 'completed', { data: carouselData });
    console.log(`[processCarousel] ✅ Job ${jobId} completed successfully - slides: ${carouselData.slides.length}`);
  } catch (error) {
    console.error(`[processCarousel] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processCarousel] Error stack:`, error.stack);
    updateJob(jobId, 'failed', { 
      data: null, 
      error: error.message || 'AI generation failed' 
    });
  }
}

/**
 * Extract carousel data from plain text if JSON parsing fails
 */
function extractCarouselFromText(text, slides) {
  const result = {
    title: 'Carousel Post',
    caption: 'Check out this carousel! 💫',
    slides: []
  };
  
  // Try to extract slides from numbered or bulleted list
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  let currentSlide = null;
  
  for (const line of lines) {
    // Check if line starts a new slide
    const slideMatch = line.match(/^(?:slide\s*)?(\d+)[\.\):]\s*(.+)/i);
    if (slideMatch) {
      if (currentSlide) {
        result.slides.push(currentSlide);
      }
      currentSlide = {
        slideNumber: parseInt(slideMatch[1]),
        title: slideMatch[2].trim(),
        content: ''
      };
    } else if (currentSlide) {
      // Add content to current slide
      if (currentSlide.content) {
        currentSlide.content += ' ' + line.trim();
      } else {
        currentSlide.content = line.trim();
      }
    } else if (line.toLowerCase().includes('title:')) {
      result.title = line.replace(/title:\s*/i, '').trim();
    } else if (line.toLowerCase().includes('caption:')) {
      result.caption = line.replace(/caption:\s*/i, '').trim();
    }
  }
  
  // Add last slide
  if (currentSlide) {
    result.slides.push(currentSlide);
  }
  
  // Ensure we have enough slides
  while (result.slides.length < slides) {
    result.slides.push({
      slideNumber: result.slides.length + 1,
      title: `Slide ${result.slides.length + 1}`,
      content: 'Content for this slide'
    });
  }
  
  return result;
}

function _scoreBand(value) {
  if (value >= 80) return 'High';
  if (value >= 55) return 'Medium';
  return 'Low';
}

function _buildViralScore({ hook = '', caption = '', hashtags = [] }) {
  const triggerWords = [
    'secret', 'mistake', 'stop', 'before', 'after', 'now', 'instantly',
    'why', 'how', 'viral', 'boost', 'hack', 'warning',
  ];
  const normalizedHook = String(hook).toLowerCase();
  const triggerHits = triggerWords.filter((w) => normalizedHook.includes(w)).length;
  const hookRaw = Math.min(100, 30 + triggerHits * 14);

  const captionLen = String(caption).length;
  let captionRaw = 45;
  if (captionLen >= 80 && captionLen <= 220) captionRaw += 25;
  else if (captionLen >= 45 && captionLen <= 300) captionRaw += 15;
  if (String(caption).includes('?') || String(caption).toLowerCase().includes('comment') || String(caption).toLowerCase().includes('save')) {
    captionRaw += 20;
  }
  captionRaw = Math.min(100, captionRaw);

  const tagCount = Array.isArray(hashtags) ? hashtags.length : 0;
  let tagRaw = 45;
  if (tagCount >= 8 && tagCount <= 15) tagRaw += 35;
  else if (tagCount >= 4) tagRaw += 20;
  tagRaw = Math.min(100, tagRaw);

  const overall = Math.round(hookRaw * 0.35 + captionRaw * 0.35 + tagRaw * 0.30);
  return {
    overall,
    hook: _scoreBand(hookRaw),
    retention: _scoreBand(Math.round((hookRaw + captionRaw) / 2)),
    viral_chance: _scoreBand(Math.round((overall + tagRaw) / 2)),
  };
}

function _safeBand(value) {
  if (value >= 75) return 'High';
  if (value >= 45) return 'Medium';
  return 'Low';
}

function _defaultViralScoreResponse() {
  return {
    score: 60,
    hook_strength: 'Medium',
    retention_score: 'Medium',
    engagement_score: 'Medium',
    viral_chance: 'Medium',
    problems: [],
    suggestions: ['Keep testing hooks and add a stronger CTA.'],
  };
}

async function viralScore(req, res) {
  try {
    const hook = String(req.body?.hook || '').trim();
    const caption = String(req.body?.caption || '').trim();
    const hashtags = Array.isArray(req.body?.hashtags) ? req.body.hashtags.map((h) => String(h).trim()).filter(Boolean) : [];
    const script = Array.isArray(req.body?.script) ? req.body.script.map((s) => String(s).trim()).filter(Boolean) : [];

    const problems = [];
    const suggestions = [];

    // 1) Hook analysis
    const emotionalWords = ['stop', "don't", 'secret', 'mistake', 'warning', 'before', 'after'];
    const hookLower = hook.toLowerCase();
    const emotionalHits = emotionalWords.filter((w) => hookLower.includes(w)).length;
    const hookLen = hook.length;
    let hookScore = 38 + emotionalHits * 14;
    if (hookLen > 0 && hookLen <= 90) hookScore += 18;
    if (hookLen > 140) {
      hookScore -= 20;
      problems.push('Hook is too long');
      suggestions.push('Shorten your first line');
    }
    if (emotionalHits === 0) {
      problems.push('Hook lacks emotional trigger');
      suggestions.push('Use a stronger hook with emotional trigger');
    }
    hookScore = Math.max(0, Math.min(100, hookScore));

    // 2) Script analysis
    const sceneCount = script.length;
    let scriptScore = 42;
    if (sceneCount >= 3 && sceneCount <= 7) scriptScore += 28;
    else if (sceneCount >= 2) scriptScore += 16;
    else if (sceneCount <= 1) {
      problems.push('Script has too few scenes');
      suggestions.push('Break script into clear scene-by-scene flow');
    }

    // basic logical flow: average line length and progression words
    const flowWords = ['first', 'then', 'next', 'finally', 'end', 'cta'];
    const flowHits = script.reduce((acc, line) => {
      const ll = line.toLowerCase();
      return acc + (flowWords.some((w) => ll.includes(w)) ? 1 : 0);
    }, 0);
    scriptScore += Math.min(20, flowHits * 5);
    if (flowHits === 0 && sceneCount > 0) {
      suggestions.push('Improve logical flow with transition cues (first, then, finally)');
    }
    scriptScore = Math.max(0, Math.min(100, scriptScore));

    // 3) Caption analysis
    const captionLower = caption.toLowerCase();
    const hasCta = ['follow', 'save', 'comment', 'share', 'dm'].some((w) => captionLower.includes(w));
    const captionLen = caption.length;
    let captionScore = 40;
    if (captionLen >= 80 && captionLen <= 220) captionScore += 24;
    else if (captionLen >= 40) captionScore += 12;
    if (hasCta) captionScore += 25;
    else {
      problems.push('Caption has no CTA');
      suggestions.push('Add CTA like "Save this post"');
    }
    if (captionLen < 20) {
      problems.push('Caption is too short');
      suggestions.push('Add a clearer value statement in caption');
    }
    captionScore = Math.max(0, Math.min(100, captionScore));

    // 4) Hashtag analysis
    const tagCount = hashtags.length;
    const uniqueTags = new Set(hashtags.map((h) => h.toLowerCase())).size;
    let hashtagScore = 38;
    if (tagCount >= 8 && tagCount <= 15) hashtagScore += 30;
    else if (tagCount >= 4) hashtagScore += 18;
    else {
      problems.push('Too few hashtags');
      suggestions.push('Use a balanced hashtag mix (8-15 tags)');
    }
    const diversityRatio = tagCount > 0 ? uniqueTags / tagCount : 0;
    if (diversityRatio >= 0.8) hashtagScore += 20;
    else if (tagCount > 0) {
      problems.push('Hashtag diversity is low');
      suggestions.push('Increase hashtag diversity and avoid duplicates');
    }
    hashtagScore = Math.max(0, Math.min(100, hashtagScore));

    const retention = Math.round(scriptScore * 0.55 + hookScore * 0.45);
    const engagement = Math.round(captionScore * 0.6 + hashtagScore * 0.4);
    const overall = Math.round(hookScore * 0.3 + retention * 0.3 + engagement * 0.4);

    const response = {
      score: overall,
      hook_strength: _safeBand(hookScore),
      retention_score: _safeBand(retention),
      engagement_score: _safeBand(engagement),
      viral_chance: _safeBand(Math.round((overall + hookScore) / 2)),
      problems,
      suggestions: Array.from(new Set(suggestions)).slice(0, 6),
    };

    console.log('[viralScore] Request:', req.body);
    console.log('[viralScore] Response:', response);
    return response;
  } catch (error) {
    console.error('[viralScore] Error:', error?.message || error);
    return _defaultViralScoreResponse();
  }
}

function _contentEngineFallback(niche = 'instagram growth') {
  const fallback = {
    idea: `3 practical ${niche} tactics creators can apply today`,
    hook: 'Stop scrolling: this one content framework can lift your reach this week.',
    script: [
      'Open with a bold pain point your audience feels daily.',
      'Share one clear method in 2 quick steps.',
      'Show a mini before/after example for proof.',
      'End with a specific CTA: save + comment for part 2.',
    ],
    caption: `If you are building in ${niche}, this framework helps you get better retention and engagement. Save this and test it today.`,
    hashtags: ['#instagramgrowth', '#contentstrategy', '#reels', '#creatorbusiness', '#socialmediatips'],
    best_time: '7:30 PM',
  };
  return {
    ...fallback,
    score: _buildViralScore({
      hook: fallback.hook,
      caption: fallback.caption,
      hashtags: fallback.hashtags,
    }),
  };
}

async function contentEngine(req, res) {
  const niche = String(req.body?.niche || '').trim();
  const goal = String(req.body?.goal || 'engagement').trim().toLowerCase();
  if (!niche) {
    return {
      ..._contentEngineFallback('instagram growth'),
      note: 'Niche was missing, using fallback niche.',
    };
  }

  console.log('[contentEngine] Request:', req.body);
  const forcedLang = detectRequestedLanguage(niche);
  const langLine = forcedLang
    ? `- Write the idea, hook, script and caption ENTIRELY in ${forcedLang}.`
    : `- If the niche is written in Hindi/Hinglish, match that language.`;
  const prompt = `You are an elite Instagram growth strategist who has scaled creator accounts from 0 to 100k+. You think in hooks, retention, and shareability.

STEP 1 — ANALYZE SILENTLY (do NOT output this): For niche "${niche}" with goal "${goal}", work out the target audience, their biggest pain or desire, the content format that performs best in this niche right now, and the emotion that drives saves/shares here.

STEP 2 — Produce ONE ready-to-post content package a creator can film TODAY.

Return ONLY valid JSON with this exact shape:
{
  "idea": "string",
  "hook": "string",
  "script": ["line1", "line2", "line3", "line4"],
  "caption": "string",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"],
  "best_time": "string"
}

Rules:
- IDEA: specific and tied to the niche + goal — never a vague "post a tip".
- HOOK: the exact first line to say/show; must stop the scroll in 1 second (bold claim, curiosity gap, or relatable pain). Ban "Did you know", "Are you making this mistake".
- SCRIPT: 4-6 short, spoken-style lines that hold retention; deliver value fast and end with a CTA.
- CAPTION: written to earn saves/shares/comments, with ONE specific CTA.
- HASHTAGS: 8-12, balanced mix (broad + mid-reach + niche), specific — never #love #viral #instagood. The audience is primarily in INDIA, so include a natural mix of India-relevant/community tags where they fit the niche.
- best_time: a realistic best posting time for an Indian audience (use IST, e.g. "7:00-9:00 PM IST").
- Everything must be practical and ready to film today.
${langLine}`;

  try {
    const raw = await runGemini(prompt, {
      maxTokens: 1200,
      temperature: 0.75,
      topP: 0.95,
    });
    const parsed = extractJsonFromText(raw) || {};
    const normalized = {
      idea: String(parsed.idea || `Actionable ${niche} content blueprint`),
      hook: String(parsed.hook || 'Stop scrolling: this framework can improve your next post.'),
      script: Array.isArray(parsed.script)
        ? parsed.script.map((x) => String(x)).filter(Boolean).slice(0, 8)
        : [],
      caption: String(parsed.caption || `Use this ${niche} framework and save for execution.`),
      hashtags: Array.isArray(parsed.hashtags)
        ? parsed.hashtags.map((h) => String(h)).filter(Boolean).slice(0, 15)
        : [],
      best_time: String(parsed.best_time || '7:30 PM'),
    };
    if (normalized.script.length === 0) {
      normalized.script = _contentEngineFallback(niche).script;
    }
    if (normalized.hashtags.length === 0) {
      normalized.hashtags = _contentEngineFallback(niche).hashtags;
    }
    const result = {
      ...normalized,
      score: _buildViralScore({
        hook: normalized.hook,
        caption: normalized.caption,
        hashtags: normalized.hashtags,
      }),
    };
    console.log('[contentEngine] Response:', result);
    return result;
  } catch (error) {
    console.error('[contentEngine] Error:', error.message);
    const fallback = _contentEngineFallback(niche);
    console.log('[contentEngine] Fallback:', fallback);
    return fallback;
  }
}

/**
 * POST /ai/rewrite — genuinely rewrite text in a chosen tone (used by AI Smart
 * Rewrite). Returns { rewritten }. Synchronous (short output).
 */
async function rewriteText(req, res) {
  const text = String(req.body?.text || '').trim();
  const tone = String(req.body?.tone || 'engaging').trim().toLowerCase();
  if (!text) {
    return { rewritten: '' };
  }

  const toneGuide = {
    simple: 'plain, clear, easy-to-read language; short words; no jargon',
    attractive: 'catchy, punchy, scroll-stopping; add a few tasteful emojis and vivid words',
    seo: 'keyword-rich and discoverable; weave in natural search terms for the topic while staying readable',
    engaging: 'conversational and interactive; spark curiosity and end with a question or soft CTA',
    professional: 'polished, credible and brand-safe; confident but not stiff',
  };
  const guide = toneGuide[tone] || toneGuide.engaging;

  const prompt = `You are an expert Instagram copywriter. Rewrite the text below in a ${tone.toUpperCase()} tone: ${guide}.

RULES:
- Keep the original meaning and any key facts.
- Match the input language (English / Hindi / Hinglish).
- Make it ready to post — NO labels, NO surrounding quotes, no "Here is", no explanation.
- Keep roughly the same length (a caption, not an essay).

TEXT:
"""${text}"""

Return ONLY the rewritten text.`;

  try {
    const output = await runGemini(prompt, { maxTokens: 800, temperature: 0.8, topP: 0.95 });
    const rewritten = String(output || '').trim().replace(/^["']|["']$/g, '');
    return { rewritten: rewritten || text };
  } catch (error) {
    console.error('[rewriteText] Error:', error.message);
    return { rewritten: text };
  }
}

async function getGrowthCoach(req, res) {
  const followers = Number(req.query.followers ?? req.body?.followers ?? 0) || 0;
  const posts = Number(req.query.posts ?? req.body?.posts ?? 0) || 0;
  const activity = String(req.query.activity ?? req.body?.activity ?? 'medium').toLowerCase();

  const dailyPlan = [
    'Post 1 high-retention short reel with clear hook.',
    'Engage with 20 relevant comments in your niche.',
    'Publish 3 stories: poll, value tip, CTA.',
  ];
  if (activity === 'low') dailyPlan.unshift('Start with one simple post today to rebuild consistency.');
  if (posts < 15) dailyPlan.push('Focus on consistency over perfection for next 7 days.');

  const tips = [
    'Use one clear CTA in every caption.',
    'Keep first 2 seconds visually dynamic.',
    'Mix broad + niche hashtags for balanced reach.',
  ];
  if (followers < 1000) tips.push('Prioritize shareable educational content to grow discovery.');

  const warnings = [];
  if (activity === 'low') warnings.push('Low activity may reduce distribution over time.');
  if (posts < 10) warnings.push('Too few posts for strong pattern learning; increase posting frequency.');
  if (warnings.length === 0) warnings.push('No major risk detected — keep momentum and test new hooks.');

  const response = {
    daily_plan: dailyPlan,
    tips,
    warnings,
  };
  console.log('[growthCoach] Response:', response);
  return response;
}

// ─── InstaFlow Studio: AI image generation ────────────────────────────────
// Compute output dimensions from any "W:H" aspect + resolution (720/1080).
// The shorter side = the chosen resolution; longer side scales by the ratio.
function studioDims(aspect, resolution) {
  const base = Number(resolution) === 720 ? 720 : 1080;
  const parts = String(aspect || '1:1').split(':').map((n) => Number(n));
  const wS = parts[0];
  const hS = parts[1];
  if (!wS || !hS || wS <= 0 || hS <= 0) return { w: base, h: base };
  const ratio = wS / hS;
  let w;
  let h;
  if (ratio >= 1) {
    h = base;
    w = Math.round(base * ratio);
  } else {
    w = base;
    h = Math.round(base / ratio);
  }
  // Clamp the long edge so we never request an enormous image.
  const MAX = 2560;
  if (w > MAX) { h = Math.round((h * MAX) / w); w = MAX; }
  if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX; }
  return { w, h };
}

const STUDIO_STYLE_HINTS = {
  minimal: 'clean minimal design, lots of negative space, simple',
  bold: 'bold vibrant colors, high contrast, punchy',
  gradient: 'smooth modern gradient background, trendy',
  photoreal: 'photorealistic, high detail, natural lighting',
  doodle: 'hand-drawn doodle illustration style, playful',
};

/**
 * POST /ai/image — generate an Instagram-ready image from a prompt (and an
 * optional input photo for restyle). Metered by aiAccess like every /ai/* route.
 * Uploads the result to Firebase Storage and returns a permanent download URL.
 */
async function generateImage(req, res) {
  const prompt = String(req.body?.prompt || '').trim();
  const aspect = /^\d{1,3}:\d{1,3}$/.test(String(req.body?.aspect || '')) ? String(req.body.aspect) : '1:1';
  const resolution = Number(req.body?.resolution) === 720 ? 720 : 1080;
  const style = String(req.body?.style || '').toLowerCase().trim();
  const inputImage = typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : '';
  const inputMime = String(req.body?.imageMimeType || 'image/jpeg');

  if (!prompt && !inputImage) {
    return res.status(400).json({ success: false, error: 'A prompt or an image is required.' });
  }

  // Build the final prompt: user prompt + style hint + aspect guidance.
  const dims = studioDims(aspect, resolution);
  const styleHint = STUDIO_STYLE_HINTS[style] ? `, ${STUDIO_STYLE_HINTS[style]}` : '';
  const fullPrompt =
    `${prompt}${styleHint}. High-quality Instagram ${aspect} image, ` +
    `sharp, well-composed, no watermark, no gibberish text.`;

  try {
    const img = await runGeminiImageGen(fullPrompt, {
      imageBase64: inputImage || undefined,
      imageMimeType: inputMime,
    });

    // Crop/resize to the requested aspect ratio.
    let buffer = Buffer.from(img.base64, 'base64');
    try {
      buffer = await sharp(buffer)
        .resize(dims.w, dims.h, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
    } catch (e) {
      console.warn('[generateImage] resize failed, using original:', e?.message);
    }

    // Upload to Firebase Storage with a permanent Firebase download URL.
    const admin = getAdmin();
    const bucket = admin?.storage ? admin.storage().bucket() : null;
    if (!bucket) throw new Error('Firebase Storage unavailable');
    const uid = req.uid || 'anon';
    const id = uuidv4();
    const objectPath = `studio_images/${uid}/${id}.png`;
    const token = randomUUID();
    await bucket.file(objectPath).save(buffer, {
      resumable: false,
      metadata: {
        contentType: 'image/png',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(objectPath)}?alt=media&token=${token}`;

    // Save to the user's Studio gallery (best-effort).
    try {
      const db = getDb();
      if (db && req.uid) {
        await db.collection('users').doc(req.uid).collection('studio').doc(id).set({
          id,
          prompt,
          aspect,
          resolution,
          style: style || null,
          url,
          path: objectPath,
          isRestyle: !!inputImage,
          createdAt: new Date(),
        });
      }
    } catch (e) {
      console.warn('[generateImage] gallery save failed:', e?.message);
    }

    if (req.uid) {
      recordAiUsage(req.uid, null, req.idempotencyKey, {
        endpoint: req._aiEndpoint || req.path || '/ai/image',
      });
    }
    console.log(`[generateImage] OK uid=${uid} aspect=${aspect} res=${resolution} restyle=${!!inputImage}`);
    return res.json({ success: true, data: { url, id, aspect, resolution } });
  } catch (error) {
    console.error('[generateImage] FAILED:', error?.message || error);
    return res.status(500).json({
      success: false,
      error: 'Image generation failed. Please try again.',
      details: error?.message || 'unknown',
    });
  }
}

// TEMPORARY: verify the deployed key can generate images + mint template
// thumbnails. GET, gated by key. Remove after use.
async function debugStudioThumb(req, res) {
  if (String(req.query.key || '') !== 'studio-debug-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const prompt = String(req.query.prompt || 'A friendly young person portrait, soft studio lighting, vertical');
  try {
    const img = await runGeminiImageGen(prompt, { temperature: 0.9, timeout: 90000 });
    const buf = await sharp(Buffer.from(img.base64, 'base64'))
      .resize(600, 800, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 82 })
      .toBuffer();
    const admin = getAdmin();
    const bucket = admin.storage().bucket();
    const token = randomUUID();
    const objectPath = `studio_thumbs/${uuidv4()}.jpg`;
    await bucket.file(objectPath).save(buf, {
      resumable: false,
      metadata: { contentType: 'image/jpeg', metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
    return res.json({ ok: true, url });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
}

module.exports = {
  generateImage,
  debugStudioThumb,
  generateCaptions,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
  generateReelsScript,
  generatePostIdeas,
  generateHashtags,
  generateBio,
  generateHooks,
  generateCommentReply,
  generateTrends,
  generateCarousel,
  contentEngine,
  rewriteText,
  getGrowthCoach,
  viralScore,
  getJobStatus,
};

