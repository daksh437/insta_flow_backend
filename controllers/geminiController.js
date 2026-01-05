const { runGemini, runGeminiWithImage } = require('../utils/geminiClient');
const { processImageForGemini } = require('../utils/imageProcessor');
const { v4: uuidv4 } = require('uuid');
const { createJob, updateJob, generateJobId, getJob } = require('../utils/jobStore');

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
  
  const englishCaptions = [
    { style: 'motivational', text: `Progress over perfection. Keep pushing forward! 💪`, hashtags: [hashtag, '#motivation', '#progress', '#growth'] },
    { style: 'fitness', text: `${mainKeyword.charAt(0).toUpperCase() + mainKeyword.slice(1)} is a lifestyle, not a phase. 🏋️`, hashtags: [hashtag, '#fitness', '#lifestyle', '#health'] },
    { style: 'mindset', text: `Strong body, stronger mindset. You've got this! 🔥`, hashtags: [hashtag, '#mindset', '#strength', '#power'] },
    { style: 'aesthetic', text: `Beauty is in the details. Find your moment. ✨`, hashtags: [hashtag, '#aesthetic', '#beauty', '#details'] },
    { style: 'inspirational', text: `Every day is a fresh start. Make it count! 🌟`, hashtags: [hashtag, '#inspiration', '#newday', '#freshstart'] },
    { style: 'confident', text: `Own your journey. You're capable of amazing things! 💫`, hashtags: [hashtag, '#confidence', '#journey', '#amazing'] },
    { style: 'energetic', text: `Let's make today count! Time to shine! ⚡`, hashtags: [hashtag, '#energy', '#shine', '#today'] },
    { style: 'positive', text: `Good vibes only. Spread the positivity! 🌈`, hashtags: [hashtag, '#positive', '#vibes', '#positivity'] },
    { style: 'creative', text: `Create. Inspire. Repeat. That's the way! 🎨`, hashtags: [hashtag, '#creative', '#inspire', '#create'] },
    { style: 'bold', text: `Bold moves lead to bold results. Let's go! 🚀`, hashtags: [hashtag, '#bold', '#results', '#goals'] },
  ];
  
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
    return [englishCaptions[randomIndex]];
  }
}

function getSystemPrompt() {
  return `You are an expert Instagram Reels caption writer.

The user will type freely what kind of caption they want.
You must automatically understand the topic, tone, language, audience, and intent.

CRITICAL RULES (FOLLOW STRICTLY):
- Generate EXACTLY 3 completely DIFFERENT captions on every request
- Each caption must be UNIQUE with different hooks, sentence structure, CTA, and phrasing
- NEVER repeat hooks, sentence structure, CTA, or phrasing between the 3 captions
- Even if the same user request is repeated, all 3 captions must be different every time
- Use fresh creative angles, new words, and new emotional hooks for each caption

CAPTION STYLE RULES (for each of the 3 captions):
- Write in short, clean lines (not a single paragraph)
- Start with a strong scroll-stopping hook
- Add emotion, curiosity, or relatability
- Use emojis naturally (do not overuse)
- Add 3–6 relevant, non-generic hashtags
- CTA must be creative and different for each caption
- Avoid boring or generic lines like:
  "Don't miss this"
  "Follow for more"
  "Like and share"

REGENERATION RULE:
If this is a regenerate request, force completely fresh captions with new angles, tone shifts, and wording. Do not reuse any phrasing.

OUTPUT FORMAT:
Return EXACTLY 3 captions, each on a separate line.
Start each caption with "• " (bullet point).
No explanations.
No labels.
No numbering.
Example format:
• First unique caption with hashtags #tag1 #tag2
• Second unique caption with hashtags #tag3 #tag4
• Third unique caption with hashtags #tag5 #tag6`;
}

function getUserPrompt(userInput, generationId, creativeSeed, requestId, regenerate) {
  const regenerateWarning = regenerate 
    ? `\n\n🚨🚨🚨 REGENERATE MODE - USER PRESSED REGENERATE BUTTON 🚨🚨🚨\n\nCRITICAL: Generate 3 COMPLETELY FRESH captions with:\n- NEW angle and perspective for each caption\n- NEW wording (zero word reuse)\n- NEW hook structure for each caption\n- NEW hashtags for each caption\n- NEW emoji placement for each caption\n- NEW sentence structure for each caption\n\nDO NOT reuse ANYTHING from previous generation.\n\n`
    : '';
  
  const timestamp = Date.now();
  const randomContext = `${Math.random().toString(36).substring(2, 15)}-${Math.floor(Math.random() * 10000)}-${Math.random().toString(36).substring(2, 10)}`;
  const variationToken = Math.random().toString(36).substring(2, 20);
  
  return `${regenerateWarning}Generate EXACTLY 3 UNIQUE Instagram Reels captions based on this request:

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
- Understand tone, language, and audience from the user's description automatically
- Generate EXACTLY 3 completely DIFFERENT captions
- Each caption must have a unique hook, structure, and CTA
- Start each caption with a strong scroll-stopping hook (different from others)
- Use short, readable lines for each caption
- Add natural emojis (1-3 max, different emojis for each caption)
- Add 3-6 relevant hashtags to each caption (completely different hashtags for each)
- Make each caption feel fresh and human-like
- If regenerate=true, use completely different angles and wording for all 3 captions

OUTPUT FORMAT:
Return EXACTLY 3 captions, each on a separate line.
Format:
• First caption text with hashtags #tag1 #tag2 #tag3
• Second caption text with hashtags #tag4 #tag5 #tag6
• Third caption text with hashtags #tag7 #tag8 #tag9

No explanations. No labels. Just 3 captions, one per line.`;
}

function calendarPrompt(topic, days) {
  return `You are a professional Instagram strategist.

Create a 7-day content calendar for: "${topic}".

For each day include:

- day_of_week
- content_type (Reel / Carousel / Story / Static Image / Meme)
- Use DIFFERENT hashtags for each caption (NO overlap)
- Use DIFFERENT angles and perspectives (first person vs second person vs third person)
- Use DIFFERENT vocabulary - avoid repeating the same words across captions
- Use DIFFERENT emotional tones even within the same mood category
- Think of each caption as written by a DIFFERENT person with a DIFFERENT voice

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

4. Generate 5-7 captions with COMPLETELY DIFFERENT writing styles and approaches:
   - Story-based / Narrative (tell a story) - Use different story angles, different characters, different scenarios
   - Question / Curiosity hook (ask engaging questions) - Ask DIFFERENT questions, use different question words (What, Why, How, When, Where)
   - Bold statement / Assertion (make strong statements) - Use DIFFERENT power words, different assertions, different perspectives
   - Emotional / Feeling-focused (express feelings) - Express DIFFERENT emotions, use different feeling words, different emotional angles
   - Action-oriented / Call-to-action (encourage action) - Use DIFFERENT action verbs, different CTAs, different urgency levels
   - Aesthetic / Visual description (describe visuals) - Describe DIFFERENT visual elements, use different descriptive words
   - Short punchline / One-liner (quick, witty) - Use DIFFERENT humor styles, different punchline structures
   
   🚨 CRITICAL: Each caption must use a DIFFERENT approach, DIFFERENT words, DIFFERENT structure - NO similarity between captions

5. Generate COMPLETELY DIFFERENT hashtags for each caption:
   - Each caption must have DIFFERENT hashtags (NO overlap between captions)
   - NO repetition within this response
   - NO reuse from previous generations
   - Mix of niche-specific, trending, and evergreen tags
   - Use the creative seed to generate varied hashtag combinations
   - Think creatively - don't use obvious hashtags, use unique combinations

6. Avoid generic Instagram phrases completely:
   - NO "Living my best life", "Good vibes only", "Making memories", "Sunshine and good times"
   - NO "Vibes", "Mood", "Feeling blessed", "Another day", "Here we go"
   - Use creative, original, human-like expressions

7. Each caption must feel fresh, original, and AI-generated (like ChatGPT):
   - Dynamic, context-aware, and unique
   - No template-based responses
   - Creative and engaging

## OUTPUT FORMAT (CRITICAL - STRICT - NO EXCEPTIONS):
Generate exactly 5-7 distinct captions following these rules:
1. Each caption on a separate line
2. Start each line with "• " (bullet point)
3. No numbering (1., 2., etc.)
4. ABSOLUTELY NO JSON format:
   - NO curly braces { }
   - NO square brackets [ ]
   - NO quotes around entire caption "text"
   - NO "captions": keyword anywhere
   - NO "hashtags": keyword anywhere
   - NO "text": keyword anywhere
   - NO "style": keyword anywhere
   - NO colons after words (like "captions:" or "hashtags:")
   - Just plain text with bullet points
5. Each caption should be distinct in approach but equally effective

🚨 CRITICAL: DO NOT write "captions": or "hashtags": anywhere in your response.
🚨 CRITICAL: DO NOT use JSON structure markers like {, }, [, ].
🚨 CRITICAL: Just write plain captions with bullet points, nothing else.

## CAPTION GUIDELINES:
1. **Length Mix**: Include short (50-100 chars), medium (100-200), long (200-300)
2. **Hashtags**: Add 3-5 relevant hashtags at the end of each caption
3. **Engagement**: Include questions, CTAs, or interactive elements based on audience type
4. **Emojis**: Use 1-3 relevant emojis per caption
5. **Platform**: Optimize for Instagram (character limits, trends)
6. **Tone**: Match the requested mood "${tone}" precisely
7. **Audience**: Tailor language to "${audience}" audience type
8. **Authenticity**: Match creator type's voice

## EXAMPLE OUTPUT FORMAT:
• Caption text here with relevant hashtags #tag1 #tag2 #tag3
• Another caption text here with hashtags #tag4 #tag5
• Third caption here with hashtags #tag6 #tag7 #tag8
• Fourth caption here with hashtags #tag9 #tag10
• Fifth caption here with hashtags #tag11 #tag12

## IMPORTANT:
- Return ONLY the 5-7 captions in bullet point format
- No additional explanations or text
- Each caption must be complete and ready to post
- Ensure variety in approach while maintaining quality
- NO JSON, NO brackets, NO quotes, NO structure markers`;
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
    
    // Extract 3 captions from output
    let captions = [];
    if (output && typeof output === 'string' && output.trim().length > 0) {
      const cleanedOutput = output.trim();
      // Remove bullet points and extra formatting
      let captionText = cleanedOutput
        .replace(/^[•\-*]\s*/gm, '')
        .replace(/^\d+[\.\)]\s*/gm, '')
        .trim();
      
      // Split by newlines and filter meaningful lines
      const lines = captionText.split(/\n/).filter(line => line.trim().length > 10);
      
      // Extract up to 3 captions
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        const line = lines[i].trim();
        if (line.length > 10) {
          // Extract hashtags
          const hashtagRegex = /#[\w]+/g;
          const hashtags = line.match(hashtagRegex) || [];
          const textWithoutHashtags = line.replace(hashtagRegex, '').trim();
          
          if (textWithoutHashtags.length > 10) {
            captions.push({
              style: 'general',
              text: textWithoutHashtags,
              hashtags: hashtags
            });
          }
        }
      }
    }
    
    // Use fallback if we don't have 3 captions
    if (captions.length < 3) {
      console.log(`[processCaptions] ⚠️ Only ${captions.length} captions extracted, using fallback for remaining`);
      const fallback = getFallbackCaptions('English', userInput);
      
      // Add fallback captions to reach 3 total
      for (let i = captions.length; i < 3; i++) {
        const fallbackIndex = (i - captions.length) % fallback.length;
        captions.push(fallback[fallbackIndex] || { 
          style: 'general', 
          text: 'Ready to create amazing content? Let\'s go! 🚀', 
          hashtags: ['#motivation', '#inspiration'] 
        });
      }
    }
    
    // Ensure we have exactly 3 captions
    captions = captions.slice(0, 3);
    
    // Update job with completed status - return 3 captions
    updateJob(jobId, 'done', { data: captions });
    console.log(`[processCaptions] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processCaptions] Error processing job ${jobId}:`, error);
    console.error(`[processCaptions] Error details:`, error.stack);
    const fallback = getFallbackCaptions('English', userInput);
    updateJob(jobId, 'done', { data: [fallback[0] || { style: 'general', text: 'Ready to create amazing content? Let\'s go! 🚀', hashtags: ['#motivation'] }], error: error.message });
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
      updateJob(jobId, 'done', { 
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
async function processCalendar(jobId, topic, days) {
  console.log(`[processCalendar] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const uniquePrompt = `${calendarPrompt(topic, days)}\n\n🎲 UNIQUE_SEED: ${uniqueSeed}\n📅 TIMESTAMP: ${timestamp}\n🔄 REQUEST_ID: ${jobId}`;
    
    console.log('[processCalendar] Calling Gemini API with unique prompt...');
    const output = await runGemini(uniquePrompt, { 
      maxTokens: 4096, 
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
    
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid calendar data from Gemini API');
    }
    
    updateJob(jobId, 'completed', { data });
    console.log(`[processCalendar] ✅ Job ${jobId} completed successfully, data items: ${data.length}`);
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
    
    updateJob(jobId, 'done', { data });
    console.log(`[processStrategy] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processStrategy] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processStrategy] Error stack:`, error.stack);
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
    
    updateJob(jobId, 'done', { data });
    console.log(`[processNicheAnalysis] ✅ Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`[processNicheAnalysis] ❌ Error processing job ${jobId}:`, error.message);
    console.error(`[processNicheAnalysis] Error stack:`, error.stack);
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

  return `You are a professional Instagram Reels Script Writer.

Your task is to generate a reel script STRICTLY based on the user's request.

USER REQUEST:
"${userInput}"

🎲 CREATIVE_SEED: ${creativeSeed}
🆔 REQUEST_ID: ${generationId}
📅 TIMESTAMP: ${Date.now()}
🔄 VARIATION_TOKEN: ${variationToken}
📐 SELECTED_ANGLE: ${selectedAngle}
🎯 HOOK_STYLE: ${selectedHookStyle}
📢 CTA_TYPE: ${selectedCTA}
${regenerateWarning}

STRICT INTERPRETATION RULES:
- If a brand name is mentioned, the script MUST clearly reflect that brand's vibe, identity, and context.
- Do NOT ignore the brand.
- Do NOT generate a generic motivational script unless the user explicitly asks for it.
- The script must directly relate to what the user requested.

EXTRACTED PARAMETERS:
- Topic/Theme: ${topic}
- Duration: ${duration} (${durationSeconds} seconds)
- Tone: ${tone} → ${toneGuidelines[tone.toLowerCase()] || 'Professional and engaging'}
- Language: ${language} → ${languageGuidelines}
- Target Audience: ${audience} → ${audienceGuidelines[audience.toLowerCase()] || 'General audience'}

DURATION RULE:
- The script must fit a ${durationSeconds}-second Instagram Reel.
- Keep it concise and spoken-friendly.
- Each line on a new line for clarity.

BRAND SAFETY RULES:
- Do not claim official brand endorsement.
- Do not use copyrighted slogans.
- You may reference brand identity indirectly (example: style, mindset, visual cues).
- If a brand is mentioned, the brand influence must be obvious in the script.

STYLE RULES:
- Sound like a real human creator speaking to camera.
- Natural flow, no headings, no lists.
- No generic hooks like "Did you know", "Are you making this mistake", "Most people do this".
- Short punchy lines.
- Emotion + confidence + clarity.
- Sounds authentic and human, not AI-generated.

STRUCTURE (do NOT label):
- Start with a powerful opening line (use ${selectedHookStyle} style, ${selectedAngle} approach)
- Build momentum
- Highlight value or story related to the user's request
- End with a strong CTA (${selectedCTA} style)

UNIQUENESS (MANDATORY):
- Every generation must be different
- Change hook, angle, and CTA every time
- Even if the same prompt is used again, output must be new
- Use the variation token (${variationToken}) to force uniqueness
- Never repeat sentence structure or phrasing

LANGUAGE RULES:
- ${languageGuidelines}
- Match tone perfectly (${tone})
- If Hinglish, mix Hindi + English naturally, not translated

CTA RULES:
- CTA must be different every time
- Type: ${selectedCTA}
- Examples (rotate creatively): comment, save, follow, share, DM, try this, think about it
- Make it feel natural, not forced
- Strong and confident, not begging

OUTPUT RULES:
- Output ONLY the reel script.
- The script must clearly relate to the user request.
- If the request mentions a brand, the brand influence must be obvious.
- No headings
- No bullet points
- No timestamps
- No explanations
- No markdown
- Just the script text, line by line, as a creator would speak it

Now generate the reel script.`;
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
 * Background processing function for reels script (handles errors with fallback)
 * Wraps the main processing logic to ensure fallback on any error
 */
async function processReelsScript(jobId, userInput, extractedParams, regenerate) {
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
    const prompt = reelsScriptPromptChatGPT(userInput, extractedParams, generationId, creativeSeed, regenerate);
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
    
    // Step 3: If still empty, throw error - NO FALLBACK
    if (!scriptData || !scriptData.hooks || !scriptData.script || !Array.isArray(scriptData.hooks) || !Array.isArray(scriptData.script)) {
      throw new Error('Failed to extract script from Gemini response. Output was empty or invalid.');
    }
    
    // Final validation
    if (scriptData.hooks.length === 0 || scriptData.script.length === 0) {
      throw new Error('Gemini returned empty hooks or script array');
    }
    
    console.log('[processReelsScript] ✅ Final script - hooks:', scriptData.hooks?.length || 0, 'scenes:', scriptData.script?.length || 0);
    console.log('[processReelsScript] ✅ Using REAL Gemini API response');
    
    // Transform to required format
    const transformedData = transformScriptData(scriptData, extractedParams.language, extractedParams.topic, extractedParams.duration);
    
    // Generate full script text (like ChatGPT format)
    const fullScript = generateFullScriptText(transformedData, output, extractedParams.language);
    transformedData.fullScript = fullScript;
    
    // Update job with completed status and data
    updateJob(jobId, 'completed', { data: transformedData });
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
    status: 'queued',
    userInput: finalUserInput,
    topic: extractedParams.topic,
    duration: finalDuration,
    tone: extractedParams.tone,
    audience: extractedParams.audience,
    language: extractedParams.language,
    regenerate: regenerate
  });
  
  // CRITICAL: Wait for Gemini API response - NO IMMEDIATE FALLBACK
  // This ensures user gets REAL AI-generated content, not hardcoded templates
  console.log(`[generateReelsScript] 🚀 Starting Gemini API call - waiting for REAL AI response...`);
  
  // Update job status to processing
  updateJob(jobId, 'processing');
  
  // Process with Gemini API (blocking - wait for response)
  processReelsScript(jobId, finalUserInput, extractedParams, regenerate)
    .then(() => {
      // Get the completed job data
      const job = getJob(jobId);
      if (job && job.status === 'completed' && job.data) {
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
      
      // Update job with error status
      updateJob(jobId, 'failed', { 
        data: null,
        error: error.message || 'AI generation failed'
      });
      
      // Return error response - NO FALLBACK
      res.status(500).json({
        success: false,
        jobId: jobId,
        error: `AI generation failed: ${error.message}`,
        data: null
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
  const { topic, niche, count = 5 } = req.body || {};
  
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: [] });
  }
  
  const jobId = generateJobId('POST_IDEAS');
  
  createJob(jobId, {
    type: 'post-ideas',
    topic: topic.trim(),
    niche: niche || '',
    count: parseInt(count) || 5,
  });
  
  console.log(`[generatePostIdeas] ===== NEW REQUEST =====`);
  console.log(`[generatePostIdeas] Job ID: ${jobId}`);
  console.log(`[generatePostIdeas] Topic: "${topic}", Niche: "${niche}", Count: ${count}`);
  
  processPostIdeas(jobId, topic.trim(), niche || '', parseInt(count) || 5)
    .catch((error) => {
      console.error(`[generatePostIdeas] Background processing failed for job ${jobId}:`, error);
      updateJob(jobId, 'done', { 
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
async function processPostIdeas(jobId, topic, niche, count) {
  console.log(`[processPostIdeas] Starting background processing for job: ${jobId}`);
  
  try {
    updateJob(jobId, 'processing', {});
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Math.floor(Math.random() * 1000000);
    const nicheContext = niche ? ` for ${niche} niche` : '';
    
    const prompt = `Generate ${count} creative and engaging Instagram post ideas${nicheContext} based on the topic: "${topic}"

Each post idea should include:
- A catchy title/headline
- A brief description (1-2 sentences)
- Suggested content angle
- Target audience
- Engagement strategy

Make each idea unique, creative, and relevant to the topic.
Ensure variety in approach, tone, and content style.

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
]

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}`;
    
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
    
    updateJob(jobId, 'completed', { data });
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
  const { topic, caption, count = 20 } = req.body || {};
  
  if (!topic && !caption) {
    return res.status(400).json({ success: false, error: 'Topic or caption is required', data: [] });
  }
  
  const jobId = generateJobId('HASHTAGS');
  
  createJob(jobId, {
    type: 'hashtags',
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
      updateJob(jobId, 'done', { 
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
    
    const prompt = `Generate ${count} relevant and trending Instagram hashtags based on: ${context}

Requirements:
- Mix of popular and niche hashtags
- Relevant to the topic/caption
- Include trending hashtags when appropriate
- Mix of broad and specific hashtags
- Include engagement-focused hashtags
- Ensure hashtags are Instagram-friendly (no spaces, special characters)

Return the hashtags as a JSON array of strings:
["#hashtag1", "#hashtag2", "#hashtag3", ...]

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
    
    updateJob(jobId, 'completed', { data });
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
  const { description, style = 'short' } = req.body || {};
  
  if (!description || description.trim() === '') {
    return res.status(400).json({ success: false, error: 'Description is required', data: null });
  }
  
  const jobId = generateJobId('BIO');
  
  createJob(jobId, {
    type: 'bio',
    description: description.trim(),
    style: style,
  });
  
  console.log(`[generateBio] ===== NEW REQUEST =====`);
  console.log(`[generateBio] Job ID: ${jobId}`);
  console.log(`[generateBio] Description: "${description.substring(0, 50)}...", Style: ${style}`);
  
  processBio(jobId, description.trim(), style)
    .catch((error) => {
      console.error(`[generateBio] Background processing failed for job ${jobId}:`, error);
      updateJob(jobId, 'done', { 
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
    
    const prompt = `Generate an engaging Instagram bio based on this description: "${description}"

Style: ${style}
${styleGuide}

Requirements:
- Engaging and authentic
- Include relevant emojis (1-3 max for short/aesthetic, more for long)
- Make it compelling and scroll-stopping
- Optimize for Instagram bio character limit
- Include a call-to-action if appropriate
- Match the style requested (${style})

Return ONLY the bio text. No explanations. No labels. Just the bio.

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
    
    updateJob(jobId, 'completed', { data: bio });
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
  const { topic, count = 5 } = req.body || {};
  
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: null });
  }
  
  const jobId = generateJobId('HOOK');
  
  createJob(jobId, {
    type: 'hooks',
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
      updateJob(jobId, 'done', { 
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
    
    const prompt = `Generate ${count} viral, scroll-stopping hooks for Instagram Reels based on this topic: "${topic}"

CRITICAL REQUIREMENTS:
- Each hook must be UNIQUE and different from others
- Hooks must be scroll-stopping (make viewers stop and watch)
- Keep hooks SHORT (5-15 words max)
- Use curiosity, emotion, or surprise
- Make them engaging and attention-grabbing
- No generic phrases like "Don't miss this" or "You won't believe"
- Each hook should have a different angle/approach

HOOK STYLES TO USE (mix different styles):
1. Question hooks (e.g., "What if I told you...")
2. Bold statements (e.g., "This changed everything...")
3. Controversial/Curiosity (e.g., "The truth nobody tells you...")
4. Personal/Relatable (e.g., "I used to think...")
5. Number/List hooks (e.g., "3 things that changed my life...")
6. Story hooks (e.g., "Last week I discovered...")

OUTPUT FORMAT:
Return EXACTLY ${count} hooks, each on a separate line.
Start each hook with "• " (bullet point).
No numbering (1., 2., etc.).
No explanations.
No labels.
Just the hooks.

Example format:
• What if I told you this one trick changed everything?
• The truth about ${topic} that nobody wants to admit
• I used to struggle with this until I discovered...
• 3 secrets that will blow your mind
• Last week I found out something that changed my life

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
    
    updateJob(jobId, 'completed', { data: finalHooks });
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
  const { comment, tone = 'friendly' } = req.body || {};
  
  if (!comment || comment.trim() === '') {
    return res.status(400).json({ success: false, error: 'Comment is required', data: null });
  }
  
  const jobId = generateJobId('REPLY');
  
  createJob(jobId, {
    type: 'comment-reply',
    comment: comment.trim(),
    tone: tone,
  });
  
  console.log(`[generateCommentReply] ===== NEW REQUEST =====`);
  console.log(`[generateCommentReply] Job ID: ${jobId}`);
  const commentPreview = comment.length > 50 ? `${comment.substring(0, 50)}...` : comment;
  console.log(`[generateCommentReply] Comment: "${commentPreview}", Tone: ${tone}`);
  
  processCommentReply(jobId, comment.trim(), tone)
    .catch((error) => {
      console.error(`[generateCommentReply] Background processing failed for job ${jobId}:`, error);
      updateJob(jobId, 'done', { 
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
async function processCommentReply(jobId, comment, tone) {
  console.log(`[processCommentReply] Starting background processing for job: ${jobId}`);
  
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
    
    const prompt = `Generate an engaging Instagram comment reply for this comment: "${comment}"

Tone: ${tone}
${toneGuide}

CRITICAL REQUIREMENTS:
- Reply should be authentic and natural
- Match the tone requested (${tone})
- Keep it concise (1-2 sentences max, under 100 characters ideally)
- Be engaging and encourage further interaction
- Use appropriate emojis (1-2 max, natural placement)
- Sound human and conversational
- Address the comment directly
- If the comment is a question, answer it
- If the comment is positive, acknowledge and thank
- If the comment is negative, be diplomatic and helpful

OUTPUT FORMAT:
Return ONLY the reply text.
No explanations.
No labels.
Just the reply.

🎲 UNIQUE_SEED: ${uniqueSeed}
📅 TIMESTAMP: ${timestamp}
🔄 REQUEST_ID: ${jobId}
🎲 RANDOM_CONTEXT: ${randomContext}`;
    
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
    
    updateJob(jobId, 'completed', { data: reply });
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
  const { niche, category = 'All' } = req.body || {};
  
  const jobId = generateJobId('TREND');
  
  createJob(jobId, {
    type: 'trends',
    niche: niche || category,
    category: category,
  });
  
  console.log(`[generateTrends] ===== NEW REQUEST =====`);
  console.log(`[generateTrends] Job ID: ${jobId}`);
  console.log(`[generateTrends] Niche: "${niche || 'All'}", Category: ${category}`);
  
  processTrends(jobId, niche || category, category)
    .catch((error) => {
      console.error(`[generateTrends] Background processing failed for job ${jobId}:`, error);
      updateJob(jobId, 'done', { 
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
    
    updateJob(jobId, 'completed', { data: trendsData });
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
  const { topic, slides = 5 } = req.body || {};
  
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: null });
  }
  
  const jobId = generateJobId('CAROUSEL');
  
  createJob(jobId, {
    type: 'carousel',
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
      updateJob(jobId, 'done', { 
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
    
    const prompt = `Generate an Instagram carousel post with ${slides} slides about: "${topic}"

CRITICAL REQUIREMENTS:
- Create EXACTLY ${slides} slides
- Each slide should have a clear, engaging message
- Slides should flow logically and tell a story
- Each slide should be concise (1-2 sentences max)
- Make it visually appealing and scroll-stopping
- Include actionable tips, insights, or information
- Use emojis naturally (1-2 per slide max)
- Make it shareable and engaging

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
    
    console.log('[processCarousel] Calling Gemini API with unique prompt...');
    const output = await runGemini(prompt, { 
      maxTokens: 2048, 
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
    
    // Ensure we have the right number of slides
    if (carouselData.slides.length < slides) {
      // Fill remaining slides
      while (carouselData.slides.length < slides) {
        carouselData.slides.push({
          slideNumber: carouselData.slides.length + 1,
          title: `Slide ${carouselData.slides.length + 1}`,
          content: 'Additional content slide'
        });
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
    
    updateJob(jobId, 'completed', { data: carouselData });
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

module.exports = {
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
  getJobStatus,
};

