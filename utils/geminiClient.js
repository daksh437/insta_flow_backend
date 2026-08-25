const axios = require('axios');

const apiKey = process.env.GEMINI_API_KEY;
const PRIMARY_MODEL = 'gemini-3-flash-preview';
const FALLBACK_MODEL = 'gemini-3.1-pro-preview';
const LEGACY_MODEL = 'gemini-pro';
const envModel = process.env.GEMINI_MODEL;

// Vision (image-in) model. Used to be hard-coded to gemini-3.1-pro-preview,
// which is 4x the price of flash ($2/$12 per 1M vs $0.50/$3) on every
// caption-from-media / image-caption / full-assist call — tools that only
// charge 2-3 credits. Flash handles these fine; override via env if a
// specific tool ever needs pro again.
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || PRIMARY_MODEL;

// Gemini 3 models think by default at thinking_level "high", and thinking
// tokens are billed at the OUTPUT rate ($3/1M on flash). For short generative
// tasks (captions, hashtags, bios) that reasoning budget is pure cost with no
// quality gain, so we default everything to "low" and let individual callers
// opt up to "medium"/"high" where the task is genuinely structural.
const DEFAULT_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low';
const VALID_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

// thinking_level only exists on the Gemini 3 family. Sending it to 2.5/1.0
// would be an unknown-field 400.
function supportsThinking(modelName) {
  return /gemini-3/.test(String(modelName || ''));
}

function resolveThinkingLevel(modelName, opts) {
  if (!supportsThinking(modelName)) return null;
  if (opts && opts.thinkingLevel === false) return null; // explicit opt-out
  const level = (opts && opts.thinkingLevel) || DEFAULT_THINKING_LEVEL;
  return VALID_THINKING_LEVELS.has(level) ? level : 'low';
}

// Set to true if the API ever rejects thinking_level, so we stop sending it
// instead of failing every subsequent request. Belt-and-braces: the field is
// documented, but a preview model changing its schema must not take the app
// down.
let thinkingLevelRejected = false;

// Per-1M-token USD rates, for the cost line in the usage log.
const PRICING = {
  'gemini-3-flash-preview': { in: 0.5, out: 3 },
  'gemini-3.1-pro-preview': { in: 2, out: 12 },
};

/**
 * Log what a call actually consumed. Until now nothing recorded token usage,
 * so real per-tool cost was unmeasurable — this is what makes the credit
 * prices in config/credits.js verifiable against reality. `thoughtsTokenCount`
 * is the thinking spend, billed as output.
 */
function logUsage(modelName, usage, label) {
  if (!usage) return;
  const inTok = usage.promptTokenCount || 0;
  const outTok = usage.candidatesTokenCount || 0;
  const thoughtTok = usage.thoughtsTokenCount || 0;
  const rate = PRICING[modelName];
  let costStr = '';
  if (rate) {
    const usd = (inTok * rate.in + (outTok + thoughtTok) * rate.out) / 1e6;
    costStr = ` cost=$${usd.toFixed(5)}`;
  }
  console.log(
    `[GeminiUsage] model=${modelName}${label ? ` tool=${label}` : ''} ` +
    `in=${inTok} out=${outTok} thoughts=${thoughtTok}${costStr}`
  );
}

if (!apiKey || apiKey.trim() === '') {
  console.warn('[GeminiClient] ⚠️ GEMINI_API_KEY not set');
}

function generateVariationNonce() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const nonce = Math.floor(Math.random() * 1000000);
  return `${timestamp}-${random}-${nonce}`;
}

function injectPromptVariation(text, nonce) {
  const zeroWidthSpace = '\u200B';
  const variationMarker = `${zeroWidthSpace}${nonce}${zeroWidthSpace}`;
  return text + variationMarker;
}

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
  
  const seedValue = opts.randomSeed || Date.now() + Math.floor(Math.random() * 1000000);
  const variationNonce = `${seedValue}-${generateVariationNonce()}`;
  
  let validatedContents = [];
  
  if (Array.isArray(contents)) {
    for (let i = 0; i < contents.length; i++) {
      const content = contents[i];
      if (content && typeof content === 'object' && !Array.isArray(content)) {
        const role = content.role || 'user';
        let parts = [];
        
        if (Array.isArray(content.parts)) {
          for (const part of content.parts) {
            if (part && typeof part === 'object' && !Array.isArray(part)) {
              if (part.text !== undefined && typeof part.text === 'string' && part.text.trim().length > 0) {
                let text = part.text.trim();
                if (role === 'user' && i === contents.length - 1) {
                  text = injectPromptVariation(text, variationNonce);
                }
                parts.push({ text: text });
              } else if (part.inlineData && typeof part.inlineData === 'object' && !Array.isArray(part.inlineData)) {
                if (part.inlineData.data && part.inlineData.mimeType) {
                  parts.push({ inlineData: part.inlineData });
                }
              }
            } else if (typeof part === 'string' && part.trim().length > 0) {
              let text = part.trim();
              if (role === 'user' && i === contents.length - 1) {
                text = injectPromptVariation(text, variationNonce);
              }
              parts.push({ text: text });
            }
          }
        } else if (typeof content.parts === 'string' && content.parts.trim().length > 0) {
          let text = content.parts.trim();
          if (role === 'user' && i === contents.length - 1) {
            text = injectPromptVariation(text, variationNonce);
          }
          parts = [{ text: text }];
        } else if (content.text !== undefined && typeof content.text === 'string' && content.text.trim().length > 0) {
          let text = content.text.trim();
          if (role === 'user' && i === contents.length - 1) {
            text = injectPromptVariation(text, variationNonce);
          }
          parts = [{ text: text }];
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
            let text = part.text.trim();
            if (role === 'user') {
              text = injectPromptVariation(text, variationNonce);
            }
            parts.push({ text: text });
          } else if (part.inlineData && typeof part.inlineData === 'object' && !Array.isArray(part.inlineData)) {
            if (part.inlineData.data && part.inlineData.mimeType) {
              parts.push({ inlineData: part.inlineData });
            }
          }
        } else if (typeof part === 'string' && part.trim().length > 0) {
          let text = part.trim();
          if (role === 'user') {
            text = injectPromptVariation(text, variationNonce);
          }
          parts.push({ text: text });
        }
      }
    } else if (typeof contents.parts === 'string' && contents.parts.trim().length > 0) {
      let text = contents.parts.trim();
      if (role === 'user') {
        text = injectPromptVariation(text, variationNonce);
      }
      parts = [{ text: text }];
    } else if (contents.text !== undefined && typeof contents.text === 'string' && contents.text.trim().length > 0) {
      let text = contents.text.trim();
      if (role === 'user') {
        text = injectPromptVariation(text, variationNonce);
      }
      parts = [{ text: text }];
    }
    
    if (parts.length > 0) {
      validatedContents.push({ role, parts });
    }
  }
  
  if (validatedContents.length === 0) {
    throw new Error('Invalid contents: No valid content items found');
  }
  
  const buildConfig = (withThinking) => {
    const generationConfig = {
      temperature: opts.temperature ?? 1.0,
      maxOutputTokens: opts.maxTokens ?? 2048,
      topP: opts.topP ?? 0.95,
      topK: opts.topK ?? 50,
    };
    const level = withThinking ? resolveThinkingLevel(actualModelName, opts) : null;
    if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
    return generationConfig;
  };

  const post = (withThinking) => axios.post(
    url,
    { contents: validatedContents, generationConfig: buildConfig(withThinking) },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
      validateStatus: (status) => status < 500,
    }
  );

  try {
    let response = await post(!thinkingLevelRejected);

    // If this preview model doesn't accept thinkingLevel, drop it permanently
    // and retry once rather than surfacing a 400 to the user.
    if (
      response.status === 400 &&
      !thinkingLevelRejected &&
      /thinking/i.test(response.data?.error?.message || '')
    ) {
      console.warn('[GeminiClient] thinkingLevel rejected by API — disabling it for this process');
      thinkingLevelRejected = true;
      response = await post(false);
    }

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

    logUsage(actualModelName, response.data?.usageMetadata, opts.label);

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
  
  const seedValue = opts.randomSeed || Date.now() + Math.floor(Math.random() * 1000000);
  const variationNonce = `${seedValue}-${generateVariationNonce()}`;
  
  let contents;
  if (opts.systemPrompt && opts.userPrompt) {
    const systemText = opts.systemPrompt.trim();
    const userText = injectPromptVariation(opts.userPrompt.trim(), variationNonce);
    contents = [
      { role: 'user', parts: [{ text: systemText }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
      { role: 'user', parts: [{ text: userText }] }
    ];
  } else {
    const promptText = injectPromptVariation(actualPrompt.trim(), variationNonce);
    contents = [{ role: 'user', parts: [{ text: promptText }] }];
  }
  
  try {
    return await callGeminiViaRestAPI(modelToUse, contents, opts);
  } catch (error) {
    throw error;
  }
}

async function runGeminiWithImage(prompt, imageBase64, imageMimeType = 'image/jpeg', opts = {}) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY missing');
  }
  
  const baseUrl = 'https://generativelanguage.googleapis.com';
  const modelName = opts.model || VISION_MODEL;
  const apiVersion = 'v1beta';
  const apiPath = `/${apiVersion}/models/${modelName}:generateContent`;
  const url = `${baseUrl}${apiPath}?key=${apiKey}`;
  
  const variationNonce = generateVariationNonce();
  const promptText = injectPromptVariation(prompt.trim(), variationNonce);
  
  const contents = [{ 
    role: 'user', 
    parts: [
      {
        inlineData: {
          data: imageBase64,
          mimeType: imageMimeType
        }
      },
      { text: promptText }
    ]
  }];
  
  const buildConfig = (withThinking) => {
    const generationConfig = {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 2048,
      topP: opts.topP ?? 0.95,
      topK: opts.topK ?? 40,
    };
    const level = withThinking ? resolveThinkingLevel(modelName, opts) : null;
    if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
    return generationConfig;
  };

  const post = (withThinking) => axios.post(
    url,
    { contents: contents, generationConfig: buildConfig(withThinking) },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: opts.timeout ?? 60000,
      validateStatus: (status) => status < 500,
    }
  );

  try {
    let response = await post(!thinkingLevelRejected);

    // Same guard as the text path: if thinkingConfig is rejected, drop it for
    // the rest of the process and retry once instead of failing the request.
    if (
      response.status === 400 &&
      !thinkingLevelRejected &&
      /thinking/i.test(response.data?.error?.message || '')
    ) {
      console.warn('[GeminiClient] thinkingConfig rejected on vision — disabling it for this process');
      thinkingLevelRejected = true;
      response = await post(false);
    }

    if (response.status >= 400) {
      const message = response.data?.error?.message || `HTTP ${response.status}`;
      if (response.status === 404) throw new Error('GEMINI_MODEL_NOT_FOUND: Model not found');
      if (response.status === 403) throw new Error('GEMINI_PERMISSION_DENIED: API key permission denied');
      throw new Error(`GEMINI_API_ERROR: ${message}`);
    }

    logUsage(modelName, response.data?.usageMetadata, opts.label);

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

/**
 * Generate an image with Gemini's image model (Nano Banana:
 * `gemini-2.5-flash-image`). Text-to-image, or image-to-image when
 * `opts.imageBase64` is provided (used for Photo Restyle).
 * Returns the generated image as { base64, mimeType }.
 */
async function runGeminiImageGen(prompt, opts = {}) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY missing');
  }
  const modelName = opts.model || 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const parts = [];
  if (opts.imageBase64) {
    parts.push({ inlineData: { data: opts.imageBase64, mimeType: opts.imageMimeType || 'image/jpeg' } });
  }
  parts.push({ text: injectPromptVariation(String(prompt || '').trim(), generateVariationNonce()) });

  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: opts.temperature ?? 0.9 },
  };

  try {
    const response = await axios.post(url, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: opts.timeout ?? 90000,
    });
    logUsage(modelName, response.data?.usageMetadata, opts.label || 'image');

    const respParts = response.data?.candidates?.[0]?.content?.parts || [];
    for (const p of respParts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        return { base64: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' };
      }
    }
    throw new Error('GEMINI_IMAGE_EMPTY: No image returned');
  } catch (error) {
    if (error.code === 'ECONNABORTED' || (error.message || '').includes('timeout')) {
      throw new Error('GEMINI_TIMEOUT: Image generation timed out');
    }
    if (error.response) {
      const status = error.response.status;
      const message = error.response.data?.error?.message || `HTTP ${status}`;
      if (status === 404) throw new Error('GEMINI_MODEL_NOT_FOUND: Image model not available');
      if (status === 403) throw new Error('GEMINI_PERMISSION_DENIED: API key lacks image access');
      throw new Error(`GEMINI_IMAGE_ERROR: ${message}`);
    }
    throw error;
  }
}

module.exports = { runGemini, runGeminiWithImage, runGeminiImageGen };
