const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const apiKey = process.env.GEMINI_API_KEY;
// Use correct Gemini model names for v1 API
// These are the exact model names available in v1 API
const PRIMARY_MODEL = 'gemini-1.5-flash';
const FALLBACK_MODEL = 'gemini-1.5-pro';
const LEGACY_MODEL = 'gemini-1.0-pro'; // Legacy fallback
const envModel = process.env.GEMINI_MODEL;

let genAI = null;
let model = null;
let isApiActive = false;
let finalModelName = PRIMARY_MODEL;

// Validate API key
if (!apiKey || apiKey.trim() === '') {
  console.warn('[GeminiClient] ⚠️ MOCK MODE - GEMINI_API_KEY not set');
} else {
  try {
    genAI = new GoogleGenerativeAI(apiKey.trim());
    console.log('[GeminiClient] ✅ GoogleGenerativeAI SDK initialized');
    
    // IMPORTANT: SDK uses v1beta by default which doesn't support Gemini 1.5
    // We'll skip SDK initialization for Gemini 1.5 models and use REST API directly
    const modelToUse = envModel && envModel.trim() !== '' ? envModel.trim() : PRIMARY_MODEL;
    
    // Check if model is Gemini 1.5 - if yes, don't use SDK
    if (modelToUse.includes('1.5')) {
      console.log(`[GeminiClient] ⚠️ Gemini 1.5 model detected: ${modelToUse}`);
      console.log('[GeminiClient] ⚠️ SDK may use v1beta, switching to REST API v1 directly');
      isApiActive = true; // We'll use REST API
      finalModelName = modelToUse;
    } else {
      // For legacy models (gemini-pro), use SDK
      try {
        model = genAI.getGenerativeModel({ model: modelToUse });
        isApiActive = true;
        finalModelName = modelToUse;
        console.log(`[GeminiClient] ✅ SDK Model initialized: ${finalModelName}`);
      } catch (modelError) {
        console.error(`[GeminiClient] ❌ Model "${modelToUse}" initialization failed:`, modelError.message);
        isApiActive = true; // We'll use REST API instead
      }
    }
  } catch (error) {
    console.error('[GeminiClient] ❌ Failed to initialize:', error.message);
    console.warn('[GeminiClient] ⚠️ Will try REST API directly');
    isApiActive = true; // Still try REST API
  }
}

// Mock data generator (unchanged)...
// Keep your existing mock response function here...

/**
 * Main function to call Gemini API - ALWAYS use REST API v1 for Gemini 1.5
 */
async function callGeminiViaRestAPI(modelName, contents, opts) {
  const timeoutMs = 20000;
  
  // CRITICAL FIX: Always use v1 API for all calls
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const apiVersion = 'v1'; // ALWAYS USE v1
  
  // Model name validation - use exact model names for v1 API
  let actualModelName = modelName;
  
  // Remove "-latest" suffix if present (v1 API doesn't support it)
  if (modelName.endsWith('-latest')) {
    actualModelName = modelName.replace(/-latest$/, '');
    console.log(`[runGemini] 🔄 Removing "-latest" suffix: "${modelName}" → "${actualModelName}"`);
  }
  
  // Map legacy model names to correct v1 model names
  const modelMap = {
    'gemini-pro': 'gemini-1.0-pro', // Legacy model mapping
  };
  
  if (modelMap[actualModelName]) {
    actualModelName = modelMap[actualModelName];
    console.log(`[runGemini] 🔄 Mapping legacy model "${modelName}" → "${actualModelName}" for v1 API`);
  }
  
  // Validate model name is one of the supported models
  const supportedModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];
  if (!supportedModels.includes(actualModelName)) {
    console.warn(`[runGemini] ⚠️ Model "${actualModelName}" may not be available in v1 API`);
    console.warn(`[runGemini] ⚠️ Supported models: ${supportedModels.join(', ')}`);
  }
  
  const apiPath = `/${apiVersion}/models/${actualModelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  console.log(`[runGemini] ==========================================`);
  console.log(`[runGemini] 🔥 Using REST API v1 ONLY`);
  console.log(`[runGemini] Model: ${actualModelName} (mapped from: ${modelName})`);
  console.log(`[runGemini] API Version: ${apiVersion}`);
  console.log(`[runGemini] URL: ${baseUrl}${apiPath}?key=${apiKey.substring(0, 10)}...`);
  console.log(`[runGemini] ==========================================`);
  
  // CRITICAL: Validate and transform contents to ensure proper JSON structure
  // Gemini API v1 requires: { contents: [{ role: 'user', parts: [{ text: '...' }] }] }
  let validatedContents = [];
  
  try {
    if (Array.isArray(contents)) {
      for (const content of contents) {
        // Ensure each content item has proper structure
        if (content && typeof content === 'object' && !Array.isArray(content)) {
          const role = content.role || 'user';
          let parts = [];
          
          // Handle parts array
          if (Array.isArray(content.parts)) {
            for (const part of content.parts) {
              if (part && typeof part === 'object' && !Array.isArray(part)) {
                // Part MUST have either 'text' or 'inlineData'
                if (part.text !== undefined && typeof part.text === 'string' && part.text.trim().length > 0) {
                  parts.push({ text: part.text.trim() });
                } else if (part.inlineData && typeof part.inlineData === 'object' && !Array.isArray(part.inlineData)) {
                  // Validate inlineData structure
                  if (part.inlineData.data && part.inlineData.mimeType) {
                    parts.push({ inlineData: part.inlineData });
                  }
                }
              } else if (typeof part === 'string' && part.trim().length > 0) {
                // If part is a string, convert to { text: string }
                parts.push({ text: part.trim() });
              }
            }
          } else if (typeof content.parts === 'string' && content.parts.trim().length > 0) {
            // If parts is a string, convert to array
            parts = [{ text: content.parts.trim() }];
          } else if (content.text !== undefined && typeof content.text === 'string' && content.text.trim().length > 0) {
            // If content has text directly, use it
            parts = [{ text: content.text.trim() }];
          }
          
          // CRITICAL: Only add content if it has at least one valid part
          if (parts.length > 0) {
            validatedContents.push({
              role: role,
              parts: parts
            });
          } else {
            console.warn(`[runGemini] ⚠️ Skipping content item with empty parts array`);
          }
        }
      }
    } else if (contents && typeof contents === 'object' && !Array.isArray(contents)) {
      // Single content object
      const role = contents.role || 'user';
      let parts = [];
      
      if (Array.isArray(contents.parts)) {
        for (const part of contents.parts) {
          if (part && typeof part === 'object' && !Array.isArray(part)) {
            if (part.text !== undefined && typeof part.text === 'string' && part.text.trim().length > 0) {
              parts.push({ text: part.text.trim() });
            } else if (part.inlineData && typeof part.inlineData === 'object' && !Array.isArray(part.inlineData)) {
              if (part.inlineData.data && part.inlineData.mimeType) {
                parts.push({ inlineData: part.inlineData });
              }
            }
          } else if (typeof part === 'string' && part.trim().length > 0) {
            parts.push({ text: part.trim() });
          }
        }
      } else if (typeof contents.parts === 'string' && contents.parts.trim().length > 0) {
        parts = [{ text: contents.parts.trim() }];
      } else if (contents.text !== undefined && typeof contents.text === 'string' && contents.text.trim().length > 0) {
        parts = [{ text: contents.text.trim() }];
      }
      
      if (parts.length > 0) {
        validatedContents.push({
          role: role,
          parts: parts
        });
      } else {
        console.warn(`[runGemini] ⚠️ Single content object has empty parts array`);
      }
    }
    
    // CRITICAL: Validate that we have at least one content item with valid parts
    if (validatedContents.length === 0) {
      console.error(`[runGemini] ❌ Invalid contents structure:`);
      console.error(`[runGemini] Original contents:`, JSON.stringify(contents, null, 2));
      throw new Error('Invalid contents: No valid content items found. Each content must have parts array with at least one part containing text or inlineData.');
    }
    
    // CRITICAL: Validate each content item has non-empty parts
    for (const content of validatedContents) {
      if (!content.parts || !Array.isArray(content.parts) || content.parts.length === 0) {
        console.error(`[runGemini] ❌ Content item has empty parts:`, JSON.stringify(content, null, 2));
        throw new Error('Invalid content: Each content item must have a non-empty parts array.');
      }
      // Validate each part has either text or inlineData
      for (const part of content.parts) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          console.error(`[runGemini] ❌ Invalid part structure:`, JSON.stringify(part, null, 2));
          throw new Error('Invalid part: Each part must be an object with either "text" or "inlineData" property.');
        }
        if (!part.text && !part.inlineData) {
          console.error(`[runGemini] ❌ Part missing text or inlineData:`, JSON.stringify(part, null, 2));
          throw new Error('Invalid part: Each part must have either "text" (string) or "inlineData" (object) property.');
        }
      }
    }
  } catch (validationError) {
    console.error(`[runGemini] ❌ Content validation failed:`, validationError.message);
    console.error(`[runGemini] Original contents:`, JSON.stringify(contents, null, 2));
    throw validationError;
  }
  
  const requestBody = {
    contents: validatedContents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 1024,
      topP: opts.topP ?? 0.95,
    },
  };
  
  // CRITICAL: Validate JSON can be stringified correctly before sending
  let jsonString;
  try {
    jsonString = JSON.stringify(requestBody, null, 2);
    // Verify JSON is valid by parsing it back
    const parsed = JSON.parse(jsonString);
    // Double-check structure
    if (!parsed.contents || !Array.isArray(parsed.contents) || parsed.contents.length === 0) {
      throw new Error('Request body must have non-empty contents array');
    }
    for (const content of parsed.contents) {
      if (!content.parts || !Array.isArray(content.parts) || content.parts.length === 0) {
        throw new Error('Each content item must have non-empty parts array');
      }
      for (const part of content.parts) {
        if (!part.text && !part.inlineData) {
          throw new Error('Each part must have either text or inlineData');
        }
      }
    }
  } catch (jsonError) {
    console.error(`[runGemini] ❌ JSON validation error:`, jsonError.message);
    console.error(`[runGemini] Request body structure:`, requestBody);
    throw new Error(`Invalid JSON payload: ${jsonError.message}`);
  }
  
  // DEBUG: Log the request body structure
  console.log(`[runGemini] ==========================================`);
  console.log(`[runGemini] ✅ Validated Request Body:`);
  console.log(`[runGemini] Contents Count: ${validatedContents.length}`);
  validatedContents.forEach((content, idx) => {
    console.log(`[runGemini]   Content ${idx + 1}: role="${content.role}", parts=${content.parts.length}`);
    content.parts.forEach((part, pidx) => {
      if (part.text) {
        const textPreview = part.text.substring(0, 50);
        console.log(`[runGemini]     Part ${pidx + 1}: text="${textPreview}${part.text.length > 50 ? '...' : ''}" (${part.text.length} chars)`);
      } else if (part.inlineData) {
        console.log(`[runGemini]     Part ${pidx + 1}: inlineData (${part.inlineData.mimeType || 'unknown'})`);
      }
    });
  });
  console.log(`[runGemini] Full JSON (first 500 chars):`, jsonString.substring(0, 500));
  console.log(`[runGemini] JSON Length: ${jsonString.length} bytes`);
  console.log(`[runGemini] ==========================================`);
  
  try {
    const response = await Promise.race([
      axios.post(url, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: timeoutMs,
        validateStatus: (status) => status < 500,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), timeoutMs)),
    ]);

    if (response.status >= 400 && response.status < 500) {
      const errorData = response.data?.error || {};
      const message = errorData.message || `HTTP ${response.status}`;
      
      console.error(`[runGemini] ❌ HTTP ${response.status}: ${message}`);
      
      if (response.status === 404) {
        console.error(`[runGemini] 💡 Model "${actualModelName}" not found in v1 API`);
        console.error(`[runGemini] 💡 Available models in v1:`);
        console.error(`[runGemini]     • gemini-1.5-flash`);
        console.error(`[runGemini]     • gemini-1.5-pro`);
        console.error(`[runGemini]     • gemini-1.0-pro`);
        throw new Error('GEMINI_MODEL_NOT_FOUND');
      }
      if (response.status === 403) {
        console.error('[runGemini] 💡 API Key permission denied');
        console.error('[runGemini] 💡 Get new key from: https://aistudio.google.com/app/apikey');
        throw new Error('GEMINI_PERMISSION_DENIED');
      }
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }

    // Extract response text
    if (response.data?.candidates?.[0]?.content?.parts) {
      let fullText = '';
      for (const part of response.data.candidates[0].content.parts) {
        if (part?.text) fullText += part.text;
      }
      if (fullText.trim()) {
        console.log(`[runGemini] ✅ REST API v1 success! Response length: ${fullText.length}`);
        return fullText;
      }
    }
    throw new Error('Empty response');
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error?.message || error.message;
      
      if (status === 404) {
        // Try fallback model
        if (modelName === PRIMARY_MODEL && PRIMARY_MODEL !== FALLBACK_MODEL) {
          console.warn(`[runGemini] ⚠️ Trying fallback: ${FALLBACK_MODEL}`);
          try {
            return await callGeminiViaRestAPI(FALLBACK_MODEL, contents, opts);
          } catch (e) {
            console.error(`[runGemini] ❌ Fallback failed: ${e.message}`);
          }
        }
        // Last resort: try legacy model
        console.warn(`[runGemini] ⚠️ Trying legacy model: ${LEGACY_MODEL}`);
        try {
          return await callGeminiViaRestAPI(LEGACY_MODEL, contents, opts);
        } catch (e) {
          throw new Error('GEMINI_MODEL_NOT_FOUND');
        }
      }
      throw error;
    }
    throw error;
  }
}

/**
 * MAIN runGemini function - ONLY uses REST API v1
 */
async function runGemini(prompt, opts = {}) {
  console.log('[runGemini] Starting...');
  
  if (!apiKey || apiKey.trim() === '') {
    console.error('[runGemini] ❌ GEMINI_API_KEY missing');
    throw new Error('GEMINI_API_UNAVAILABLE: Set GEMINI_API_KEY environment variable');
  }
  
  // Validate prompt
  let actualPrompt = prompt;
  if (!actualPrompt || actualPrompt.trim().length === 0) {
    if (opts.userPrompt && opts.userPrompt.trim().length > 0) {
      actualPrompt = opts.userPrompt;
    } else {
      throw new Error('Prompt cannot be empty');
    }
  }
  
  console.log(`[runGemini] Using REST API v1 - Model: ${PRIMARY_MODEL}, Prompt length: ${actualPrompt.length}`);
  
  // Prepare contents
  let contents;
  if (opts.systemPrompt && opts.userPrompt) {
    contents = [
      { role: 'user', parts: [{ text: opts.systemPrompt }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
      { role: 'user', parts: [{ text: opts.userPrompt }] }
    ];
  } else {
    contents = [{ role: 'user', parts: [{ text: actualPrompt }] }];
  }
  
  // ALWAYS use REST API v1 (skip SDK completely)
  try {
    return await callGeminiViaRestAPI(PRIMARY_MODEL, contents, opts);
  } catch (error) {
    console.error('[runGemini] ❌ Error:', error.message);
    
    if (error.message === 'GEMINI_MODEL_NOT_FOUND') {
      console.error('[runGemini] 💡 Available models in v1:');
      console.error('[runGemini]     • gemini-1.5-flash');
      console.error('[runGemini]     • gemini-1.5-pro');
      console.error('[runGemini]     • gemini-1.0-pro');
      console.error('[runGemini] 💡 Current PRIMARY_MODEL:', PRIMARY_MODEL);
    }
    
    throw error;
  }
}

// Vision API function (also using REST API v1)
async function runGeminiWithImage(prompt, imageBase64, imageMimeType = 'image/jpeg', opts = {}) {
  console.log('[runGeminiWithImage] Using REST API v1...');
  
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY missing');
  }
  
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const apiVersion = 'v1';
  const modelName = 'gemini-1.5-pro'; // Vision needs pro model
  
  const apiPath = `/${apiVersion}/models/${modelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  const contents = [{ 
    role: 'user', 
    parts: [
      {
        inlineData: {
          data: imageBase64,
          mimeType: imageMimeType
        }
      },
      { text: prompt }
    ]
  }];
  
  const requestBody = {
    contents: contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 2048,
    },
  };
  
  try {
    const response = await axios.post(url, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    
    if (response.data?.candidates?.[0]?.content?.parts) {
      let fullText = '';
      for (const part of response.data.candidates[0].content.parts) {
        if (part?.text) fullText += part.text;
      }
      return fullText;
    }
    throw new Error('Empty response');
  } catch (error) {
    console.error('[runGeminiWithImage] Error:', error.message);
    throw error;
  }
}

module.exports = { runGemini, runGeminiWithImage };