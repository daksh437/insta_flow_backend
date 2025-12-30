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
    
    console.log(`[processReelsScript] Job ${jobId} - Calling Gemini API...`);
    const prompt = reelsScriptPrompt(topic.trim(), duration, tone.trim(), audience.trim(), language.trim(), generationId, creativeSeed, regenerate);
    console.log(`[processReelsScript] Job ${jobId} - Prompt length: ${prompt.length} characters`);
    console.log(`[processReelsScript] Job ${jobId} - Using model: ${process.env.GEMINI_MODEL || 'gemini-3-flash-preview'}`);
    
    const timestamp = Date.now();
    const uniqueSeed = timestamp + Number(process.hrtime.bigint() % 1000000n) + Math.floor(Math.random() * 1000000);
    
    console.log(`[processReelsScript] Unique Seed: ${uniqueSeed}`);
    
    const output = await runGemini(prompt, {
      maxTokens: 2048,
      temperature: 1.0,
      topP: 0.95,
      topK: 50,
      randomSeed: uniqueSeed
    });
    
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
    const transformedData = transformScriptData(scriptData, language, topic, duration);
    
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
  const { topic, duration = '15s', tone = 'Motivational', audience = 'Creator', language = 'English', regenerate = false } = req.body || {};
  
  // Validate required parameters
  if (!topic || topic.trim() === '') {
    return res.status(400).json({ success: false, error: 'Topic is required', data: {} });
  }
  
  // Validate duration (15s, 30s, 60s only)
  const validDurations = ['15s', '30s', '60s'];
  const finalDuration = validDurations.includes(duration) ? duration : '15s';
  
  // Generate unique job ID
  const jobId = generateJobId('REELS');
  
  console.log(`[generateReelsScript] ==========================================`);
  console.log(`[generateReelsScript] NEW REQUEST - Job ${jobId}`);
  console.log(`[generateReelsScript] Topic: "${topic}", Duration: ${finalDuration}, Tone: ${tone}, Audience: ${audience}, Language: ${language}`);
  console.log(`[generateReelsScript] ==========================================`);
  
  // Create job with queued status in jobStore
  createJob(jobId, {
    type: 'reels-script',
    status: 'queued',
    topic: topic.trim(),
    duration: finalDuration,
    tone: tone.trim(),
    audience: audience.trim(),
    language: language.trim(),
    regenerate: regenerate
  });
  
  // IMMEDIATE RESPONSE MODE: Generate fallback script and return data immediately
  // This ensures Flutter app always gets data, even when Gemini models fail
  try {
    console.log(`[generateReelsScript] ⚡ IMMEDIATE FALLBACK MODE - Generating fallback script NOW`);
    const fallbackScript = getFallbackReelsScript(language.trim(), topic.trim(), finalDuration);
    console.log(`[generateReelsScript] ✅ Fallback script generated - hooks: ${fallbackScript.hooks?.length || 0}, scenes: ${fallbackScript.script?.length || 0}`);
    
    const transformedData = transformScriptData(fallbackScript, language.trim(), topic.trim(), finalDuration);
    console.log(`[generateReelsScript] ✅ Transformed data ready:`);
    console.log(`[generateReelsScript]    - hook: "${transformedData.hook?.substring(0, 50)}..."`);
    console.log(`[generateReelsScript]    - scene_by_scene: ${transformedData.scene_by_scene?.length || 0} scenes`);
    console.log(`[generateReelsScript]    - cta: "${transformedData.cta?.substring(0, 30)}..."`);
    console.log(`[generateReelsScript]    - hashtags: ${transformedData.hashtags?.length || 0} tags`);
    
    // Update job with completed status and data
    updateJob(jobId, 'completed', { data: transformedData });
    
    // CRITICAL: Return data directly in response (Flutter expects this format)
    console.log(`[generateReelsScript] ✅ SENDING RESPONSE WITH DATA to Flutter app`);
    console.log(`[generateReelsScript] Response format: { success: true, jobId: "${jobId}", data: {...} }`);
    res.json({
      success: true,
      jobId: jobId,
      data: transformedData
    });
    
    // Still try Gemini in background (non-blocking) - but don't wait for it
    setImmediate(() => {
      updateJob(jobId, 'processing');
      console.log(`[generateReelsScript] 🔄 Job ${jobId} - Attempting Gemini API in background (non-blocking)...`);
      
      processReelsScript(jobId, topic.trim(), finalDuration, tone.trim(), audience.trim(), language.trim(), regenerate)
        .then(() => {
          console.log(`[generateReelsScript] ✅ Background Gemini succeeded for job ${jobId} - job updated with AI data`);
        })
        .catch(error => {
          console.error(`[generateReelsScript] ⚠️ Background Gemini processing error for job ${jobId}:`, error.message);
          // Job already has fallback data, so this is just for logging - user already got response
        });
    });
  } catch (error) {
    console.error(`[generateReelsScript] ❌ Error generating fallback script:`, error);
    // Even if fallback fails, return basic structure
    const basicData = {
      hook: language.trim() === 'Hindi' ? 'क्या आप जानते हैं?' : 
            language.trim() === 'Hinglish' ? 'Kya aap jaante hain?' : 
            `Did you know about ${topic.trim()}?`,
      scene_by_scene: [{
        time: '0-3s',
        visual: 'Close-up selfie',
        dialogue: language.trim() === 'Hindi' ? 'यह बहुत महत्वपूर्ण है' : 
                  language.trim() === 'Hinglish' ? 'Yeh bahut important hai' : 
                  `Let's talk about ${topic.trim()}`
      }, {
        time: '3-8s',
        visual: 'Medium shot',
        dialogue: language.trim() === 'Hindi' ? 'आपको यह जानना चाहिए' : 
                  language.trim() === 'Hinglish' ? 'Aapko yeh jaanna chahiye' : 
                  'This is something you need to know'
      }, {
        time: '8-12s',
        visual: 'Wide shot',
        dialogue: language.trim() === 'Hindi' ? 'यह आपकी जिंदगी बदल देगा' : 
                  language.trim() === 'Hinglish' ? 'Yeh aapki life badal dega' : 
                  'This will change your life'
      }, {
        time: '12-15s',
        visual: 'Selfie',
        dialogue: language.trim() === 'Hindi' ? 'इस पोस्ट को सेव करें' : 
                  language.trim() === 'Hinglish' ? 'Is post ko save karein' : 
                  'Save this post for later'
      }],
      cta: language.trim() === 'Hindi' ? 'इस पोस्ट को सेव करें' : 
           language.trim() === 'Hinglish' ? 'Is post ko save karein' : 
           'Save this post',
      caption: language.trim() === 'Hindi' ? `यह ${topic.trim()} के बारे में महत्वपूर्ण जानकारी है` : 
               language.trim() === 'Hinglish' ? `Yeh ${topic.trim()} ke baare mein important info hai` : 
               `Check out this amazing content about ${topic.trim()}`,
      hashtags: ['#reels', '#viral', '#instagram', '#content', '#trending', '#fyp', '#explore', '#growth', '#success', '#motivation']
    };
    
    updateJob(jobId, 'completed', { data: basicData });
    console.log(`[generateReelsScript] ✅ Returning basic fallback data for job ${jobId}`);
    res.json({
      success: true,
      jobId: jobId,
      data: basicData
    });
  }
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
          const fallbackScript = getFallbackReelsScript(job.language || 'English', job.topic || 'motivation', job.duration || '15s');
          response.data = transformScriptData(
            fallbackScript,
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
  
  // Include error message if failed status
  if (job.status === 'failed' && job.error) {
    response.error = job.error;
  }
  
  console.log(`[getJobStatus] Job ${jobId} (type: ${job.type}) status: ${apiStatus}`);
  res.json(response);
}

module.exports = {
  generateCaptions,
  generateImageCaptions,
  generateCaptionFromMedia,
  generateCalendar,
  generateStrategy,
  analyzeNiche,
  generateReelsScript,
  getJobStatus,
};

