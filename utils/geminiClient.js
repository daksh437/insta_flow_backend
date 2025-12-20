const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const apiKey = process.env.GEMINI_API_KEY;
// Use latest Gemini models with v1 API
// Primary: gemini-1.5-flash (fast, latest)
// Fallback: gemini-1.5-pro (more capable)
const PRIMARY_MODEL = 'gemini-1.5-flash';
const FALLBACK_MODEL = 'gemini-1.5-pro';
const envModel = process.env.GEMINI_MODEL;

let genAI = null;
let model = null;
let isApiActive = false;
let finalModelName = PRIMARY_MODEL; // Track the final model being used

// Validate API key
if (!apiKey || apiKey.trim() === '') {
  console.warn('[GeminiClient] ⚠️ MOCK MODE - GEMINI_API_KEY not set');
  console.warn('[GeminiClient] ⚠️ API calls will fail. Set GEMINI_API_KEY environment variable for production.');
  console.warn('[GeminiClient] 💡 To fix: Add GEMINI_API_KEY to your .env file or Render environment variables');
} else {
  // Validate API key format (should start with AIza...)
  const apiKeyPrefix = apiKey.trim().substring(0, 4);
  const apiKeyLength = apiKey.trim().length;
  
  if (apiKeyPrefix !== 'AIza' || apiKeyLength < 35) {
    console.warn(`[GeminiClient] ⚠️ WARNING: API key format looks invalid (starts with "${apiKeyPrefix}", length: ${apiKeyLength})`);
    console.warn('[GeminiClient] ⚠️ Expected format: AIza... (39+ characters)');
    console.warn('[GeminiClient] 💡 Get your API key from: https://aistudio.google.com/app/apikey');
  } else {
    console.log(`[GeminiClient] ✅ API key found (length: ${apiKeyLength}, starts with: ${apiKeyPrefix}...)`);
  }
  
  try {
    genAI = new GoogleGenerativeAI(apiKey.trim());
    console.log('[GeminiClient] ✅ GoogleGenerativeAI SDK initialized');
    
    // Try to use env model if provided, otherwise use primary model
    let modelToUse = envModel && envModel.trim() !== '' ? envModel.trim() : PRIMARY_MODEL;
    
    try {
      model = genAI.getGenerativeModel({ model: modelToUse });
      isApiActive = true;
      finalModelName = modelToUse;
      console.log(`🤖 Gemini Model: ${finalModelName}`);
      console.log(`[GeminiClient] ✅ REAL MODE - Model initialized: ${finalModelName}`);
      console.log(`[GeminiClient] Model source: ${envModel ? `GEMINI_MODEL env var ("${envModel}")` : `hardcoded primary model ("${PRIMARY_MODEL}")`}`);
    } catch (modelError) {
      // If primary model fails, try fallback model
      console.error(`[GeminiClient] ❌ Model "${modelToUse}" initialization failed:`, modelError.message);
      if (modelToUse !== FALLBACK_MODEL) {
        console.warn(`[GeminiClient] ⚠️ Trying fallback model: ${FALLBACK_MODEL}`);
        try {
          model = genAI.getGenerativeModel({ model: FALLBACK_MODEL });
          isApiActive = true;
          finalModelName = FALLBACK_MODEL;
          console.log(`[GeminiClient] ✅ Fallback successful - Using model: ${finalModelName}`);
        } catch (fallbackError) {
          console.error('[GeminiClient] ❌ Fallback model also failed:', fallbackError.message);
          console.error('[GeminiClient] 💡 This might be an API key permission issue. Check:');
          console.error('[GeminiClient]    1. API key is valid and active');
          console.error('[GeminiClient]    2. API key has Gemini API enabled');
          console.error('[GeminiClient]    3. Get new key from: https://aistudio.google.com/app/apikey');
          model = null;
          isApiActive = false;
          console.warn('[GeminiClient] ⚠️ MOCK MODE - All models failed, using fallback scripts');
        }
      } else {
        console.error('[GeminiClient] ❌ Primary model failed:', modelError.message);
        console.error('[GeminiClient] 💡 Check API key permissions at: https://aistudio.google.com/app/apikey');
        model = null;
        isApiActive = false;
        console.warn('[GeminiClient] ⚠️ MOCK MODE - Model initialization failed, using fallback scripts');
      }
    }
  } catch (error) {
    console.error('[GeminiClient] ❌ Failed to initialize GoogleGenerativeAI:', error.message);
    console.error('[GeminiClient] 💡 Verify GEMINI_API_KEY is correct in environment variables');
    model = null;
    isApiActive = false;
    console.warn('[GeminiClient] ⚠️ MOCK MODE - API initialization failed');
  }
}

// Mock data generator for testing without API key
function getMockResponse(prompt) {
  if (prompt.includes('captions')) {
    return JSON.stringify([
      { caption: 'Living my best life! ✨ Who else can relate? Save this!', hashtags: ['#lifestyle', '#vibes', '#instagood', '#happy', '#life', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Good vibes only! 🌟 What\'s your vibe today? Share with a friend!', hashtags: ['#goodvibes', '#positive', '#energy', '#mood', '#happy', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Making memories one day at a time 📸', hashtags: ['#memories', '#photography', '#moments', '#life', '#captured', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Sunshine and good times ☀️ Save this for later!', hashtags: ['#sunshine', '#goodtimes', '#summer', '#bright', '#happy', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Just another day in paradise 🌴', hashtags: ['#paradise', '#travel', '#adventure', '#explore', '#wanderlust', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Coffee and good vibes ☕✨ Share with a friend!', hashtags: ['#coffee', '#vibes', '#morning', '#energy', '#goodday', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Living in the moment 💫', hashtags: ['#moment', '#present', '#mindful', '#life', '#now', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Creating my own sunshine 🌞 Save this!', hashtags: ['#sunshine', '#create', '#positive', '#energy', '#bright', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Every day is a fresh start 🌅 What are you grateful for today?', hashtags: ['#gratitude', '#mindfulness', '#growth', '#wellness', '#peace', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
      { caption: 'Small steps, big dreams 🚀 Keep going! Share with a friend!', hashtags: ['#dreams', '#goals', '#motivation', '#success', '#growth', '#trending', '#viral', '#motivation', '#inspiration', '#selfcare'] },
    ]);
  }
  if (prompt.includes('calendar')) {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const contentTypes = ['Reel', 'Carousel', 'Story', 'Single Image', 'Meme'];
    const hooks = [
      'POV: You just discovered this game-changing tip',
      'Stop scrolling if you want to 10x your results',
      'This changed everything for me',
      'Nobody talks about this but...',
      'I wish I knew this sooner',
      'The secret nobody tells you',
      'This will blow your mind'
    ];
    const ctas = [
      'Save this post for later!',
      'Share with someone who needs this',
      'Comment your thoughts below',
      'Double tap if you agree',
      'Follow for more tips',
      'Share your experience in comments',
      'Tag someone who needs to see this'
    ];
    return JSON.stringify(days.map((day, index) => ({
      day_of_week: day,
      content_type: contentTypes[index % contentTypes.length],
      hook: hooks[index % hooks.length],
      caption: `${hooks[index % hooks.length]} 💡 This ${day.toLowerCase()} tip will transform your approach. The results speak for themselves!`,
      hashtag_set: [
        '#trending', '#viral', '#instagram', '#content', '#growth',
        '#tips', '#strategy', '#success', '#motivation', '#inspiration',
        '#lifestyle', '#business', '#entrepreneur', '#mindset', '#goals'
      ],
      best_posting_time: ['6 PM IST', '7 PM IST', '8 PM IST', '9 AM IST', '10 AM IST', '11 AM IST', '5 PM IST'][index],
      content_brief: `Create ${contentTypes[index % contentTypes.length].toLowerCase()} content with engaging visuals, clear text overlays, and dynamic transitions that capture attention in the first 3 seconds.`,
      viral_angle: `This post taps into current trends, uses proven engagement hooks, and provides actionable value that encourages saves and shares. The timing aligns with peak engagement hours.`,
      cta: ctas[index % ctas.length]
    })));
  }
  if (prompt.includes('strategy')) {
    return JSON.stringify({
      audience_profile: {
        target_age_groups: ['18-24', '25-34', '35-44'],
        motivations: ['Personal growth', 'Community connection', 'Learning new skills', 'Entertainment', 'Inspiration'],
        psychological_triggers: ['FOMO (Fear of Missing Out)', 'Social proof', 'Aspiration', 'Relatability', 'Achievement'],
        problems_they_want_solved: ['Lack of direction', 'Need for authentic connections', 'Desire for quick wins', 'Information overload', 'Time management']
      },
      growth_plan: {
        reel_strategy: 'Post 3-5 Reels per week focusing on trending audio, quick tips, and behind-the-scenes content. Use first 3 seconds hook, add captions, and include strong CTAs.',
        posting_schedule: 'Post daily at 6 PM IST (peak engagement), with Reels on Mon/Wed/Fri and Feed posts on Tue/Thu/Sat. Stories 2-3 times daily.',
        content_to_avoid: ['Overly promotional posts', 'Low-quality images', 'Generic quotes without context', 'Posts without clear value', 'Inconsistent branding'],
        style_guide: {
          colors: 'Primary: Purple (#7B2CBF), Secondary: Pink (#9D4EDD), Accent: White. Maintain 80/20 rule for brand colors.',
          tone: 'Friendly, authentic, empowering, and slightly playful. Avoid being preachy or overly salesy.',
          personality: 'Approachable expert, relatable friend, inspiring mentor'
        }
      },
      viral_content_ideas: [
        {
          hook: 'POV: You just discovered the secret to 10x growth',
          angle: 'Behind-the-scenes transformation story',
          expected_engagement_reason: 'Relatable struggle + quick win = high saves and shares'
        },
        {
          hook: 'Stop scrolling if you want real results',
          angle: 'Contrarian take on common advice',
          expected_engagement_reason: 'Curiosity gap + controversy = comments and debate'
        },
        {
          hook: 'This changed everything for me in 30 days',
          angle: 'Personal journey with before/after',
          expected_engagement_reason: 'Social proof + transformation = high engagement'
        },
        {
          hook: 'Nobody talks about this but...',
          angle: 'Unpopular truth or hidden insight',
          expected_engagement_reason: 'Exclusive knowledge = saves and shares'
        },
        {
          hook: 'I wish I knew this 5 years ago',
          angle: 'Regret-based learning moment',
          expected_engagement_reason: 'Relatability + value = comments and saves'
        },
        {
          hook: 'The mistake 90% of people make',
          angle: 'Common error + solution',
          expected_engagement_reason: 'Problem-solution format = high engagement'
        },
        {
          hook: 'POV: You\'re about to go viral',
          angle: 'Meta content about going viral',
          expected_engagement_reason: 'Self-referential humor = shares and comments'
        },
        {
          hook: 'This will save you 10 hours per week',
          angle: 'Time-saving hack or tool',
          expected_engagement_reason: 'Practical value = high saves'
        },
        {
          hook: 'The truth nobody wants to hear',
          angle: 'Hard truth or reality check',
          expected_engagement_reason: 'Controversy + truth = debate and shares'
        },
        {
          hook: 'I tried this for 7 days and...',
          angle: 'Challenge or experiment results',
          expected_engagement_reason: 'Curiosity + results = high engagement'
        }
      ],
      analytics_insights: {
        best_posting_times: ['6 PM IST', '7 PM IST', '8 PM IST', '9 AM IST'],
        average_competition_strength: 'Medium-High. Focus on unique angles and consistent quality to stand out.',
        content_gap_opportunities: ['Educational carousels', 'User-generated content', 'Behind-the-scenes Reels', 'Interactive polls and Q&As'],
        posting_frequency_impact: 'Posting 1-2 times daily shows 40% higher engagement vs 3-4 times per week. Quality over quantity is key.'
      },
      hashtag_strategy: {
        low_competition_tags: ['#nichegrowth', '#authenticcontent', '#smallbusinessowner', '#contentcreatorlife', '#socialmediatips', '#growthmindset', '#creativelife', '#digitalmarketing', '#brandbuilding', '#communityfirst'],
        mid_competition_tags: ['#instagramgrowth', '#contentstrategy', '#socialmediamarketing', '#digitalmarketing', '#contentcreator', '#instagramtips', '#socialmediatips', '#marketingstrategy', '#brandgrowth', '#engagement'],
        high_competition_tags: ['#instagram', '#marketing', '#business', '#entrepreneur', '#success', '#motivation', '#inspiration', '#growth', '#viral', '#trending']
      },
      cta_strategy: 'Use varied CTAs: "Save this post", "Share with someone who needs this", "Comment your experience", "Double tap if you agree", "Follow for daily tips". Rotate CTAs to avoid repetition and test which drives most engagement.'
    });
  }
  if (prompt.includes('Analyze the Instagram niche') || prompt.includes('analyze')) {
    return JSON.stringify({
      trend_forecast_30_days: {
        week_1: 'Short-form educational content will dominate. Quick tips and "POV" formats will see 40% higher engagement.',
        week_2: 'Behind-the-scenes and authentic storytelling will peak. Users crave real connections over polished content.',
        week_3: 'Interactive content (polls, Q&As, challenges) will surge. Engagement rates expected to increase by 25%.',
        week_4: 'Trending audio integration will be crucial. Reels with trending sounds will get 3x more reach.',
        overall_trend: 'Shift towards authentic, value-driven content. Educational and relatable content will outperform promotional posts.'
      },
      top_5_viral_patterns: [
        {
          pattern: 'POV (Point of View) storytelling',
          engagement_rate: 'High',
          reason: 'Creates immediate relatability and emotional connection'
        },
        {
          pattern: 'Before/After transformations',
          engagement_rate: 'Very High',
          reason: 'Visual proof + social proof = high saves and shares'
        },
        {
          pattern: 'Quick tip carousels',
          engagement_rate: 'High',
          reason: 'Actionable value in swipeable format increases time spent'
        },
        {
          pattern: 'Trending audio + original hook',
          engagement_rate: 'Very High',
          reason: 'Algorithm boost from trending audio + unique angle'
        },
        {
          pattern: 'Contrarian takes on common advice',
          engagement_rate: 'High',
          reason: 'Creates debate and discussion in comments'
        }
      ],
      best_3_reel_formats: [
        {
          format: 'Quick Tips Reel (15-30 seconds)',
          description: 'Fast-paced, text-overlay format with trending audio. Start with hook, deliver value, end with CTA.',
          expected_performance: 'High reach, good engagement, high save rate'
        },
        {
          format: 'Transformation Story Reel (30-60 seconds)',
          description: 'Before/after visual journey with emotional storytelling. Use trending audio that matches the mood.',
          expected_performance: 'Very high engagement, viral potential, high share rate'
        },
        {
          format: 'Day-in-the-Life Reel (45-90 seconds)',
          description: 'Authentic behind-the-scenes content showing real moments. Use casual, relatable tone.',
          expected_performance: 'Strong engagement, builds connection, good for community building'
        }
      ],
      hashtag_clusters: {
        low_competition: ['#nichegrowth', '#authenticcontent', '#smallbusinessowner', '#contentcreatorlife', '#socialmediatips', '#growthmindset', '#creativelife', '#digitalmarketing', '#brandbuilding', '#communityfirst'],
        mid_competition: ['#instagramgrowth', '#contentstrategy', '#socialmediamarketing', '#digitalmarketing', '#contentcreator', '#instagramtips', '#socialmediatips', '#marketingstrategy', '#brandgrowth', '#engagement'],
        high_competition: ['#instagram', '#marketing', '#business', '#entrepreneur', '#success', '#motivation', '#inspiration', '#growth', '#viral', '#trending']
      },
      untapped_content_ideas: [
        'User-generated content series featuring community members',
        'Myth-busting content debunking common misconceptions',
        'Collaborative content with micro-influencers in the niche',
        'Data-driven insights with original research or surveys',
        'Interactive challenges that encourage participation',
        'Behind-the-scenes of content creation process',
        'Real-time problem-solving sessions',
        'Comparison content (this vs that) with honest opinions'
      ],
      psychological_triggers: [
        {
          trigger: 'FOMO (Fear of Missing Out)',
          application: 'Use phrases like "Don\'t miss out", "Limited time", "Join before it\'s too late"',
          effectiveness: 'High - drives immediate action'
        },
        {
          trigger: 'Social Proof',
          application: 'Showcase testimonials, user results, follower count, engagement metrics',
          effectiveness: 'Very High - builds trust and credibility'
        },
        {
          trigger: 'Curiosity Gap',
          application: 'Start with intriguing hook, reveal answer gradually, use "You won\'t believe..."',
          effectiveness: 'High - increases watch time and engagement'
        },
        {
          trigger: 'Scarcity',
          application: 'Limited offers, exclusive content, time-sensitive deals',
          effectiveness: 'High - creates urgency'
        },
        {
          trigger: 'Relatability',
          application: 'Share struggles, failures, real moments. "POV: You..." format works well',
          effectiveness: 'Very High - builds connection and trust'
        },
        {
          trigger: 'Achievement/Status',
          application: 'Show transformation, success stories, milestones. "I went from X to Y"',
          effectiveness: 'High - inspires and motivates'
        }
      ],
      common_mistakes: [
        {
          mistake: 'Posting inconsistently',
          impact: 'Algorithm penalizes irregular posting. Engagement drops by 30-40%.',
          solution: 'Create content calendar, batch create content, use scheduling tools'
        },
        {
          mistake: 'Ignoring analytics',
          impact: 'Posting blind without understanding what works. Wasting time on low-performing content.',
          solution: 'Review insights weekly, identify top performers, double down on what works'
        },
        {
          mistake: 'Over-promoting',
          impact: 'Audience disengages from constant sales pitches. Engagement rate drops.',
          solution: 'Follow 80/20 rule: 80% value, 20% promotion. Focus on building trust first'
        },
        {
          mistake: 'Copying competitors exactly',
          impact: 'No differentiation, algorithm doesn\'t favor duplicate content.',
          solution: 'Get inspired but add unique angle, personal story, or different perspective'
        },
        {
          mistake: 'Ignoring captions',
          impact: 'Missing opportunity to engage. Captions drive comments and saves.',
          solution: 'Write compelling hooks, ask questions, include CTAs, tell stories'
        },
        {
          mistake: 'Not engaging with audience',
          impact: 'One-way communication kills community. Low engagement rates.',
          solution: 'Reply to comments within 2 hours, engage in DMs, create community content'
        },
        {
          mistake: 'Posting at wrong times',
          impact: 'Content gets buried. Missing peak engagement windows.',
          solution: 'Use analytics to find your audience\'s active hours, test different times'
        }
      ]
    });
  }
  return JSON.stringify({ message: 'Mock response - add GEMINI_API_KEY for real AI' });
}

/**
 * Fallback: Call Gemini API directly via REST API (v1 endpoint)
 * This bypasses SDK's v1beta usage when models fail
 */
async function callGeminiViaRestAPI(modelName, contents, opts) {
  const timeoutMs = 20000; // 20 seconds
  
  // CRITICAL: Use correct v1 API endpoint
  // Base URL: https://generativelanguage.googleapis.com
  // API Version: v1 (not v1beta)
  // Endpoint: /v1/models/{MODEL_NAME}:generateContent
  // API key as query parameter: ?key={API_KEY}
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const apiVersion = 'v1';
  const apiPath = `/${apiVersion}/models/${modelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  // Validate URL structure to prevent incorrect URLs
  if (!url.includes('generativelanguage.googleapis.com')) {
    throw new Error('Invalid API base URL');
  }
  if (!url.includes(`/${apiVersion}/models/`)) {
    throw new Error(`Invalid API version - must use ${apiVersion}`);
  }
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY is missing');
  }
  
  const requestBody = {
    contents: contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 1024,
      topP: opts.topP ?? 0.95,
    },
  };

  try {
    console.log(`[runGemini] Calling REST API (${apiVersion}) for model: ${modelName}`);
    console.log(`[runGemini] REST API URL: ${baseUrl}${apiPath}?key=***`);
    const response = await Promise.race([
      axios.post(url, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), timeoutMs)),
    ]);

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      const candidate = response.data.candidates[0];
      if (candidate.content && candidate.content.parts) {
        let fullText = '';
        for (const part of candidate.content.parts) {
          if (part && part.text) {
            fullText += part.text;
          }
        }
        if (fullText && fullText.trim().length > 0) {
          console.log(`[runGemini] ✅ REST API (v1) success - Response length: ${fullText.length}`);
          return fullText;
        }
      }
    }
    throw new Error('Empty response from REST API');
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error?.message || error.message;
      console.error(`[runGemini] REST API error - Status: ${status}, Message: ${message}`);
      if (status === 404) {
        // If primary model fails, try fallback model
        if (modelName === PRIMARY_MODEL && PRIMARY_MODEL !== FALLBACK_MODEL) {
          console.warn(`[runGemini] ⚠️ ${PRIMARY_MODEL} failed in REST API, trying ${FALLBACK_MODEL}...`);
          try {
            return await callGeminiViaRestAPI(FALLBACK_MODEL, contents, opts);
          } catch (lastError) {
            console.error(`[runGemini] ❌ Fallback model ${FALLBACK_MODEL} also failed:`, lastError.message);
            throw new Error('GEMINI_MODEL_NOT_FOUND');
          }
        }
        throw new Error('GEMINI_MODEL_NOT_FOUND');
      }
      if (status === 403) {
        throw new Error('GEMINI_PERMISSION_DENIED: API key is invalid or does not have permission.');
      }
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }
    if (error.message === 'GEMINI_TIMEOUT') {
      throw new Error('GEMINI_TIMEOUT');
    }
    throw error;
  }
}

/**
 * Internal function to call Gemini API with a specific model
 */
async function callGeminiWithModel(modelInstance, modelName, contents, opts) {
  const timeoutMs = 20000; // 20 seconds hard timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      console.log(`[runGemini] ⚠️ HARD TIMEOUT reached after ${timeoutMs}ms`);
      reject(new Error('GEMINI_TIMEOUT'));
    }, timeoutMs);
  });

  const apiPromise = modelInstance.generateContent({
    contents: contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 1024,
      topP: opts.topP ?? 0.95,
    },
  }).catch(apiError => {
    // Handle Gemini API errors (403 permission denied, 404 model not found, etc.)
    console.error(`[runGemini] Gemini API error (${modelName}):`, apiError.message);
    console.error(`[runGemini] Error code:`, apiError.code);
    console.error(`[runGemini] Error status:`, apiError.status);
    
    // Check for specific error types - 403 PERMISSION_DENIED is most critical
    if (apiError.status === 403 || apiError.message?.includes('PERMISSION_DENIED') || apiError.message?.includes('403') || apiError.message?.includes('unregistered callers')) {
      console.error('[runGemini] ❌ API KEY PERMISSION ERROR');
      console.error('[runGemini] 💡 Fix steps:');
      console.error('[runGemini]    1. Verify GEMINI_API_KEY is set in environment variables');
      console.error('[runGemini]    2. Check API key is valid at: https://aistudio.google.com/app/apikey');
      console.error('[runGemini]    3. Ensure API key has Gemini API enabled');
      console.error('[runGemini]    4. Regenerate API key if needed');
      throw new Error('GEMINI_PERMISSION_DENIED: API key is invalid or does not have permission. Please check your GEMINI_API_KEY environment variable.');
    }
    if (apiError.status === 404 || apiError.message?.includes('not found') || apiError.message?.includes('404')) {
      throw new Error('GEMINI_MODEL_NOT_FOUND');
    }
    if (apiError.message?.includes('quota') || apiError.message?.includes('rate limit')) {
      throw new Error('GEMINI_QUOTA_EXCEEDED: API quota exceeded. Please try again later.');
    }
    
    // Generic API error
    throw new Error(`GEMINI_API_ERROR: ${apiError.message || 'Unknown API error'}`);
  }).then(result => {
    console.log(`[runGemini] API response received from ${modelName}`);
    
    // CRITICAL: Safely extract text by concatenating ALL content.parts[].text
    try {
      const response = result.response;
      
      // Method 1: PRIORITY - Safely iterate over candidates[0].content.parts and concatenate ALL text
      if (response && response.candidates && response.candidates.length > 0) {
        const candidate = response.candidates[0];
        if (candidate && candidate.content && candidate.content.parts) {
          let fullText = '';
          for (const part of candidate.content.parts) {
            if (part && part.text && typeof part.text === 'string') {
              fullText += part.text;
            }
          }
          if (fullText && fullText.trim().length > 0) {
            console.log('[runGemini] Extracted text via candidates[0].content.parts (concatenated), length:', fullText.length);
            return fullText;
          }
        }
      }
      
      // Method 2: Try response.text() as fallback
      if (response && typeof response.text === 'function') {
        const text = response.text();
        if (text && typeof text === 'string' && text.trim().length > 0) {
          console.log('[runGemini] Extracted text via response.text(), length:', text.length);
          return text;
        }
      }
      
      // Method 3: Try direct property access
      if (response && response.text) {
        const text = typeof response.text === 'function' ? response.text() : response.text;
        if (text && typeof text === 'string' && text.trim().length > 0) {
          console.log('[runGemini] Extracted text via response.text property, length:', text.length);
          return text;
        }
      }
      
      console.warn('[runGemini] Could not extract text from response');
      console.warn('[runGemini] Response structure:', JSON.stringify({
        hasResponse: !!response,
        hasCandidates: !!(response && response.candidates),
        candidatesLength: response && response.candidates ? response.candidates.length : 0
      }, null, 2));
      throw new Error('Unable to extract text from Gemini response');
    } catch (extractError) {
      console.error('[runGemini] Error extracting text:', extractError.message);
      throw extractError;
    }
  });

  console.log(`[runGemini] Waiting for API response from ${modelName} or timeout (20s max)...`);
  
  // CRITICAL: Use Promise.race to enforce hard timeout
  // If Gemini takes longer than 20 seconds, timeout wins and throws GEMINI_TIMEOUT
  const response = await Promise.race([apiPromise, timeoutPromise]);
  
  console.log(`[runGemini] ✅ Gemini API success (${modelName}) - Response length: ${response?.length || 0}`);
  return response;
}

async function runGemini(prompt, opts = {}) {
  console.log('[runGemini] Starting...');
  
  // If no API key or genAI not initialized, throw error (no silent fallback)
  if (!genAI || !isApiActive) {
    console.error('[runGemini] ERROR: Gemini API is not available');
    throw new Error('GEMINI_API_UNAVAILABLE: Gemini API key is missing or model initialization failed. Please set GEMINI_API_KEY environment variable.');
  }
  
  try {
    // CRITICAL: Validate prompt is not empty
    if (!prompt || (typeof prompt === 'string' && prompt.trim().length === 0)) {
      // If prompt is empty but we have userPrompt in opts, use that
      if (opts.userPrompt && opts.userPrompt.trim().length > 0) {
        console.log('[runGemini] Prompt is empty, using userPrompt from opts');
        prompt = opts.userPrompt;
      } else {
        console.warn('[runGemini] WARNING: Prompt is empty and no userPrompt provided');
        throw new Error('Prompt cannot be empty');
      }
    }
    
    console.log(`[runGemini] Calling Gemini API - Model: ${finalModelName}, Prompt length: ${prompt.length}`);
    
    // Support role-based prompting (system + user) or single prompt
    let contents;
    if (opts.systemPrompt && opts.userPrompt) {
      // ChatGPT-style: system role for instructions, user role for input
      contents = [
        { role: 'user', parts: [{ text: opts.systemPrompt }] },
        { role: 'model', parts: [{ text: 'Understood. I will follow all guidelines strictly.' }] },
        { role: 'user', parts: [{ text: opts.userPrompt }] }
      ];
      console.log('[runGemini] Using role-based prompting (system + user)');
    } else {
      // Fallback: single user prompt
      contents = [{ role: 'user', parts: [{ text: prompt }] }];
      console.log('[runGemini] Using single prompt');
    }
    
    // Use the initialized model (already validated at startup)
    let response;
    try {
      response = await callGeminiWithModel(model, finalModelName, contents, opts);
      return response;
    } catch (modelError) {
      // If model not found and we have a fallback model, try it
      if (modelError.message === 'GEMINI_MODEL_NOT_FOUND' && finalModelName !== FALLBACK_MODEL) {
        console.warn(`[runGemini] ⚠️ Primary model "${finalModelName}" failed, trying fallback: ${FALLBACK_MODEL}`);
        try {
          // Try fallback model dynamically
          const fallbackModelInstance = genAI.getGenerativeModel({ model: FALLBACK_MODEL });
          response = await callGeminiWithModel(fallbackModelInstance, FALLBACK_MODEL, contents, opts);
          console.log(`[runGemini] ✅ Fallback model "${FALLBACK_MODEL}" succeeded`);
          return response;
        } catch (fallbackError) {
          console.error(`[runGemini] ❌ Fallback model "${FALLBACK_MODEL}" also failed:`, fallbackError.message);
          // If both SDK models fail, try REST API directly with v1 endpoint using gemini-pro
          if (fallbackError.message === 'GEMINI_MODEL_NOT_FOUND') {
            console.warn(`[runGemini] ⚠️ Both SDK models failed, trying REST API with v1 endpoint (gemini-pro)...`);
            try {
              return await callGeminiViaRestAPI('gemini-pro', contents, opts);
            } catch (restError) {
              console.error(`[runGemini] ❌ REST API also failed:`, restError.message);
              throw modelError; // Throw original error
            }
          }
          throw modelError; // Throw original error
        }
      }
      // If primary model fails with GEMINI_MODEL_NOT_FOUND, try REST API with v1 endpoint
      if (modelError.message === 'GEMINI_MODEL_NOT_FOUND') {
        console.warn(`[runGemini] ⚠️ SDK model failed, trying REST API with v1 endpoint (${PRIMARY_MODEL})...`);
        try {
          return await callGeminiViaRestAPI(PRIMARY_MODEL, contents, opts);
        } catch (restError) {
          console.error(`[runGemini] ❌ REST API failed:`, restError.message);
          throw modelError; // Re-throw original error
        }
      }
      throw modelError; // Re-throw if not a model not found error or no fallback available
    }
  } catch (error) {
    console.error('[runGemini] ERROR:', error.message);
    console.error('[runGemini] ERROR Stack:', error.stack);
    
    // CRITICAL: If timeout occurred, throw clear GEMINI_TIMEOUT error
    if (error.message === 'GEMINI_TIMEOUT' || error.message.includes('GEMINI_TIMEOUT')) {
      console.error('[runGemini] ⚠️ GEMINI_TIMEOUT - API call exceeded 20 seconds');
      throw new Error('GEMINI_TIMEOUT');
    }
    
    // Re-throw specific Gemini errors (model not found, quota, etc.)
    if (error.message.startsWith('GEMINI_')) {
      throw error;
    }
    
    // DO NOT fallback to mock - throw error so controller can return proper error JSON
    throw new Error(`Gemini API failed: ${error.message}`);
  }
}

// Run Gemini with image (Vision API)
async function runGeminiWithImage(prompt, imageBase64, imageMimeType = 'image/jpeg', opts = {}) {
  console.log('[runGeminiWithImage] Starting with image...');
  
  // If no API key or genAI not initialized, throw error (no silent fallback)
  if (!genAI || !isApiActive) {
    console.error('[runGeminiWithImage] ERROR: Gemini API is not available');
    throw new Error('GEMINI_API_UNAVAILABLE: Gemini API key is missing or model initialization failed. Please set GEMINI_API_KEY environment variable.');
  }
  
  try {
    console.log('[runGeminiWithImage] Calling Gemini Vision API...');
    console.log(`[runGeminiWithImage] Model: ${finalModelName}, Image size: ${imageBase64.length} bytes, MIME type: ${imageMimeType}`);
    console.log(`[runGeminiWithImage] Prompt length: ${prompt.length} characters`);
    
    // Prepare image part
    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: imageMimeType
      }
    };
    
    // Prepare text part
    const textPart = {
      text: prompt
    };
    
    const contents = [{ 
      role: 'user', 
      parts: [imagePart, textPart]
    }];
    
    // Add timeout wrapper - 60 seconds for Gemini API
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.log('[runGeminiWithImage] Timeout reached (60 seconds)');
        reject(new Error('Gemini Vision API timeout after 60 seconds'));
      }, 60000); // 60 seconds timeout
    });

    const apiPromise = model.generateContent({
      contents: contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? 2048,
        topP: opts.topP ?? 0.95,
      },
    }).catch(apiError => {
      // Handle Gemini API errors
      console.error(`[runGeminiWithImage] Gemini API error (${finalModelName}):`, apiError.message);
      console.error('[runGeminiWithImage] Error code:', apiError.code);
      console.error('[runGeminiWithImage] Error status:', apiError.status);
      
      if (apiError.status === 403 || apiError.message?.includes('PERMISSION_DENIED') || apiError.message?.includes('403') || apiError.message?.includes('unregistered callers')) {
        console.error('[runGeminiWithImage] ❌ API KEY PERMISSION ERROR');
        console.error('[runGeminiWithImage] 💡 Fix: Check GEMINI_API_KEY in environment variables');
        throw new Error('GEMINI_PERMISSION_DENIED: API key is invalid or does not have permission. Please check your GEMINI_API_KEY environment variable.');
      }
      if (apiError.status === 404 || apiError.message?.includes('not found') || apiError.message?.includes('404')) {
        throw new Error('GEMINI_MODEL_NOT_FOUND: The specified model is not available. Please check your model name.');
      }
      if (apiError.message?.includes('quota') || apiError.message?.includes('rate limit')) {
        throw new Error('GEMINI_QUOTA_EXCEEDED: API quota exceeded. Please try again later.');
      }
      
      throw new Error(`GEMINI_API_ERROR: ${apiError.message || 'Unknown API error'}`);
    }).then(result => {
      console.log(`[runGeminiWithImage] API response received from ${finalModelName}`);
      return result.response.text();
    });

    const response = await Promise.race([apiPromise, timeoutPromise]);
    console.log('[runGeminiWithImage] Response received, length:', response?.length || 0);
    return response;
  } catch (error) {
    console.error('[runGeminiWithImage] Error:', error.message);
    
    // Re-throw specific Gemini errors
    if (error.message.startsWith('GEMINI_')) {
      throw error;
    }
    
    // Re-throw timeout errors
    if (error.message && error.message.includes('timeout')) {
      throw error;
    }
    
    // For other errors, throw with context
    throw new Error(`Gemini Vision API failed: ${error.message}`);
  }
}

module.exports = { runGemini, runGeminiWithImage };

