const axios = require('axios');

const apiKey = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-3-pro-preview';
const LEGACY_MODEL = 'gemini-pro';
const envModel = process.env.GEMINI_MODEL;

if (!apiKey || apiKey.trim() === '') {
  console.warn('[GeminiClient] ⚠️ GEMINI_API_KEY not set');
}

/**
 * Call Gemini API via REST
 */
async function callGeminiViaRestAPI(modelName, contents, opts) {
  const timeoutMs = opts.timeout ?? 60000;
  
  const baseUrl = 'https://generativelanguage.googleapis.com';
  let apiVersion = 'v1beta';
  
  if (modelName.includes('1.0') || modelName === 'gemini-pro') {
    apiVersion = 'v1';
  }
  
  let actualModelName = modelName;
  if (modelName.endsWith('-latest')) {
    actualModelName = modelName.replace(/-latest$/, '');
  }
  
  if (!actualModelName.includes('3') && !actualModelName.includes('3-')) {
    const modelMap = {
      'gemini-pro': 'gemini-1.0-pro',
    };
    if (modelMap[actualModelName]) {
      actualModelName = modelMap[actualModelName];
    }
  }
  
  const apiPath = `/${apiVersion}/models/${actualModelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  // Validate and normalize contents
  let validatedContents = [];
  
  if (Array.isArray(contents)) {
    for (const content of contents) {
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        const role = content.role || 'user';
        let parts = [];
        
        if (Array.isArray(content.parts)) {
          for (const part of content.parts) {
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
        } else if (typeof content.parts === 'string' && content.parts.trim().length > 0) {
          parts = [{ text: content.parts.trim() }];
        } else if (content.text !== undefined && typeof content.text === 'string' && content.text.trim().length > 0) {
          parts = [{ text: content.text.trim() }];
        }
        
        if (parts.length > 0) {
          validatedContents.push({ role, parts });
        }
      }
    }
  } else if (contents && typeof contents === 'object' && !Array.isArray(contents)) {
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
      validatedContents.push({ role, parts });
    }
  }
  
  if (validatedContents.length === 0) {
    throw new Error('Invalid contents: No valid content items found');
  }
  
  // Generate fresh randomSeed for each request
  const randomSeed = Math.floor(Math.random() * 2147483647);
  
  // Create fresh generation config for each request
  const generationConfig = {
    temperature: opts.temperature ?? 1.0,
    maxOutputTokens: opts.maxTokens ?? 2048,
    topP: opts.topP ?? 0.9,
    topK: opts.topK ?? 50,
    randomSeed: randomSeed,
  };
  
  const requestBody = {
    contents: validatedContents,
    generationConfig: generationConfig,
  };
  
  try {
    const response = await axios.post(url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
      validateStatus: (status) => status < 500,
    });
    
    if (response.status >= 400) {
      const errorData = response.data?.error || {};
      const message = errorData.message || `HTTP ${response.status}`;
      
      if (response.status === 404) {
        throw new Error(`GEMINI_MODEL_NOT_FOUND: Model "${actualModelName}" not found`);
      }
      if (response.status === 403) {
        throw new Error('GEMINI_PERMISSION_DENIED: API key permission denied');
      }
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }
    
    if (response.data?.candidates?.[0]?.content?.parts) {
      let fullText = '';
      for (const part of response.data.candidates[0].content.parts) {
        if (part?.text) fullText += part.text;
      }
      if (fullText.trim()) {
        return fullText;
      }
    }
    
    throw new Error('GEMINI_EMPTY_RESPONSE: No text in response');
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('GEMINI_TIMEOUT: Request timed out');
    }
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data?.error || {};
      const message = errorData.message || `HTTP ${status}`;
      
      if (status === 404) {
        throw new Error(`GEMINI_MODEL_NOT_FOUND: Model not found`);
      }
      if (status === 403) {
        throw new Error('GEMINI_PERMISSION_DENIED: API key permission denied');
      }
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }
    throw error;
  }
}

/**
 * Main runGemini function
 */
async function runGemini(prompt, opts = {}) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_UNAVAILABLE: GEMINI_API_KEY not set');
  }
  
  let actualPrompt = prompt;
  if (!actualPrompt || actualPrompt.trim().length === 0) {
    if (opts.userPrompt && opts.userPrompt.trim().length > 0) {
      actualPrompt = opts.userPrompt;
    } else {
      throw new Error('Prompt cannot be empty');
    }
  }
  
  let modelToUse = PRIMARY_MODEL;
  
  if (envModel && envModel.trim() !== '' && (envModel.includes('1.0') || envModel === 'gemini-pro')) {
    modelToUse = PRIMARY_MODEL;
  }
  
  if (modelToUse !== PRIMARY_MODEL) {
    modelToUse = PRIMARY_MODEL;
  }
  
  if (modelToUse.includes('1.0') && !modelToUse.includes('3')) {
    modelToUse = PRIMARY_MODEL;
  }
  
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
  
  try {
    return await callGeminiViaRestAPI(modelToUse, contents, opts);
  } catch (error) {
    throw error;
  }
}

/**
 * Vision API function
 */
async function runGeminiWithImage(prompt, imageBase64, imageMimeType = 'image/jpeg', opts = {}) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY missing');
  }
  
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const modelName = 'gemini-3-pro-preview';
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
  
  // Generate fresh randomSeed for each request
  const randomSeed = Math.floor(Math.random() * 2147483647);
  
  const requestBody = {
    contents: contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 2048,
      topP: opts.topP ?? 0.95,
      topK: opts.topK ?? 40,
      randomSeed: randomSeed,
    },
  };
  
  try {
    const response = await axios.post(url, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: opts.timeout ?? 60000,
    });
    
    if (response.data?.candidates?.[0]?.content?.parts) {
      let fullText = '';
      for (const part of response.data.candidates[0].content.parts) {
        if (part?.text) fullText += part.text;
      }
      if (fullText.trim()) {
        return fullText;
      }
    }
    
    throw new Error('GEMINI_EMPTY_RESPONSE: No text in response');
  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      throw new Error('GEMINI_TIMEOUT: Request timed out');
    }
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data?.error || {};
      const message = errorData.message || `HTTP ${status}`;
      
      if (status === 404) {
        throw new Error('GEMINI_MODEL_NOT_FOUND: Model not found');
      }
      if (status === 403) {
        throw new Error('GEMINI_PERMISSION_DENIED: API key permission denied');
      }
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }
    throw error;
  }
}

module.exports = { runGemini, runGeminiWithImage };
