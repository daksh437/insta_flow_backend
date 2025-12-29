const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const apiKey = process.env.GEMINI_API_KEY;
// Use correct Gemini model names for v1beta API (Gemini 3.0 preview models)
// These are the exact model names available in Google AI Studio
const PRIMARY_MODEL = 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-3-pro-preview';
const LEGACY_MODEL = 'gemini-pro'; // Legacy fallback
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
    
    // IMPORTANT: Using Gemini 3.0 models with v1beta API (preview models)
    // We'll use REST API v1beta directly for Gemini 3.0 models
    let modelToUse = envModel && envModel.trim() !== '' ? envModel.trim() : PRIMARY_MODEL;
    
    // For Gemini 3.0 models, use REST API v1beta directly
    if (modelToUse.includes('3.') || modelToUse.includes('3-')) {
      console.log(`[GeminiClient] ✅ Gemini 3.0 model detected: ${modelToUse}`);
      console.log('[GeminiClient] ✅ Using REST API v1beta directly (for preview models)');
      isApiActive = true; // We'll use REST API v1beta
      finalModelName = modelToUse;
    } else if (modelToUse.includes('1.0') || modelToUse === 'gemini-pro') {
      // For legacy models (1.0, gemini-pro), use v1 API
      console.log(`[GeminiClient] ✅ Legacy model detected: ${modelToUse}`);
      console.log('[GeminiClient] ✅ Using REST API v1 directly');
      isApiActive = true; // We'll use REST API v1
      finalModelName = modelToUse;
    } else {
      // For other models, try SDK first
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
 * Main function to call Gemini API - Uses REST API v1beta for Gemini 3.0 models
 */
async function callGeminiViaRestAPI(modelName, contents, opts) {
  const timeoutMs = 20000;
  
  // CRITICAL FIX: Use v1beta for Gemini 3.0 models, v1 for legacy models
  const baseUrl = 'https://generativelanguage.googleapis.com';
  // Determine API version based on model name
  let apiVersion = 'v1beta'; // Default for Gemini 3.0 preview models
  
  // For legacy models (1.0, gemini-pro), use v1 API
  if (modelName.includes('1.0') || modelName === 'gemini-pro') {
    apiVersion = 'v1';
    console.log(`[runGemini] Using v1 API for legacy model: ${modelName}`);
  } else {
    console.log(`[runGemini] Using v1beta API for model: ${modelName}`);
  }
  
  // Model name validation - use exact model names for v1 API
  let actualModelName = modelName;
  
  // Remove "-latest" suffix if present (v1 API doesn't support it)
  if (modelName.endsWith('-latest')) {
    actualModelName = modelName.replace(/-latest$/, '');
    console.log(`[runGemini] 🔄 Removing "-latest" suffix: "${modelName}" → "${actualModelName}"`);
  }
  
  // Map legacy model names to correct v1 model names
  // CRITICAL: Don't remap Gemini 3.0 models - they should be used as-is
  if (!actualModelName.includes('3') && !actualModelName.includes('3-')) {
    const modelMap = {
      'gemini-pro': 'gemini-1.0-pro', // Legacy model mapping (only for non-3.0 models)
    };
    
    if (modelMap[actualModelName]) {
      actualModelName = modelMap[actualModelName];
      console.log(`[runGemini] 🔄 Mapping legacy model "${modelName}" → "${actualModelName}" for v1 API`);
    }
  } else {
    console.log(`[runGemini] ✅ Using Gemini 3.0 model as-is: ${actualModelName}`);
  }
  
  // Validate model name is one of the supported models
  const supportedModels = ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-1.0-pro', 'gemini-pro'];
  if (!supportedModels.includes(actualModelName)) {
    console.warn(`[runGemini] ⚠️ Model "${actualModelName}" may not be available in v1 API`);
    console.warn(`[runGemini] ⚠️ Supported models: ${supportedModels.join(', ')}`);
  }
  
  const apiPath = `/${apiVersion}/models/${actualModelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  console.log(`[runGemini] ==========================================`);
  console.log(`[runGemini] 🔥 Using REST API ${apiVersion} for ${actualModelName}`);
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
    // Error handling - don't recursively call callGeminiViaRestAPI
    // All fallback logic is already handled in the 404 response handler above
    if (error.message === 'GEMINI_MODEL_NOT_FOUND' || error.message === 'GEMINI_TIMEOUT') {
      throw error; // Re-throw to let upper level handle
    }
    throw error;
  }
}

/**
 * MAIN runGemini function - Uses REST API v1beta for Gemini 3.0 models
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
  
  // CRITICAL: Always use PRIMARY_MODEL (gemini-3-flash-preview)
  // Ignore any environment variable overrides that might set old models
  let modelToUse = PRIMARY_MODEL;
  
  // Safety check: If envModel is set to an old model, ignore it and use PRIMARY_MODEL
  if (envModel && envModel.trim() !== '' && (envModel.includes('1.0') || envModel === 'gemini-pro')) {
    console.warn(`[runGemini] ⚠️ GEMINI_MODEL env var is set to old model "${envModel}", ignoring and using PRIMARY_MODEL: ${PRIMARY_MODEL}`);
    modelToUse = PRIMARY_MODEL;
  }
  
  // Ensure we're using the correct model - never default to old models
  if (modelToUse !== PRIMARY_MODEL) {
    console.warn(`[runGemini] ⚠️ Model was changed from PRIMARY_MODEL, resetting to: ${PRIMARY_MODEL}`);
    modelToUse = PRIMARY_MODEL;
  }
  
  // Final validation: If somehow we still have an old model, force PRIMARY_MODEL
  if (modelToUse.includes('1.0') && !modelToUse.includes('3')) {
    console.warn(`[runGemini] ⚠️ Detected old model "${modelToUse}", forcing PRIMARY_MODEL: ${PRIMARY_MODEL}`);
    modelToUse = PRIMARY_MODEL;
  }
  
  console.log(`[runGemini] ✅ Using REST API - Model: ${modelToUse}, Prompt length: ${actualPrompt.length}`);
  console.log(`[runGemini] ✅ PRIMARY_MODEL constant: ${PRIMARY_MODEL}`);
  console.log(`[runGemini] ✅ Model being used: ${modelToUse}`);
  
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
  
  // ALWAYS use REST API v1beta for Gemini 3.0 models (skip SDK completely)
  try {
    return await callGeminiViaRestAPI(modelToUse, contents, opts);
  } catch (error) {
    console.error('[runGemini] ❌ Error:', error.message);
    
    if (error.message === 'GEMINI_MODEL_NOT_FOUND') {
      console.error('[runGemini] 💡 Available models:');
      console.error('[runGemini]     • gemini-3-flash-preview');
      console.error('[runGemini]     • gemini-3-pro-preview');
      console.error('[runGemini]     • gemini-1.0-pro');
      console.error('[runGemini]     • gemini-pro');
      console.error('[runGemini] 💡 Current PRIMARY_MODEL:', PRIMARY_MODEL);
      console.error('[runGemini] 💡 Model used in call:', modelToUse);
    }
    
    throw error;
  }
}

// Vision API function (using REST API v1beta for Gemini 3.0 models)
async function runGeminiWithImage(prompt, imageBase64, imageMimeType = 'image/jpeg', opts = {}) {
  console.log('[runGeminiWithImage] Using REST API v1beta for Gemini 3.0...');
  
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY missing');
  }
  
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const modelName = 'gemini-3-pro-preview'; // Vision uses 3.0-pro model
  // Gemini 3.0 models require v1beta API
  const apiVersion = 'v1beta';
  
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

module.exports = { runGemini, runGeminiWithImage };   
    
 
// Deploy trigger: 12/29/2025 15:40:09
