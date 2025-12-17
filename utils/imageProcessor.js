const sharp = require('sharp');

/**
 * Process and optimize image before sending to Gemini Vision
 * - Resize to max 384px width (maintain aspect ratio) - optimized for free tier speed
 * - Convert to JPEG
 * - Compress to 60% quality - faster upload and processing
 */
async function processImageForGemini(imageBase64, imageMimeType = 'image/jpeg') {
  try {
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const originalSizeKB = Math.round(imageBuffer.length / 1024);
    
    console.log(`[imageProcessor] Processing image: ${originalSizeKB} KB`);
    
    // Process with sharp - smaller size for faster Gemini processing (free tier)
    // Using 384px for faster processing on free Gemini tier
    const processedBuffer = await sharp(imageBuffer)
      .resize(384, null, {
        withoutEnlargement: true,
        fit: 'inside'
      })
      .jpeg({ quality: 60, mozjpeg: true }) // Lower quality for faster upload
      .toBuffer();
    
    // Convert back to base64
    const processedBase64 = processedBuffer.toString('base64');
    const processedSizeKB = Math.round(processedBuffer.length / 1024);
    
    const reductionPercent = ((originalSizeKB - processedSizeKB) / originalSizeKB * 100).toFixed(1);
    console.log(`[imageProcessor] ✅ Optimized: ${originalSizeKB} KB → ${processedSizeKB} KB (${reductionPercent}% reduction)`);
    
    return {
      base64: processedBase64,
      mimeType: 'image/jpeg',
      sizeKB: processedSizeKB
    };
  } catch (error) {
    console.error('[imageProcessor] Error processing image:', error.message);
    // If processing fails, return original (but log warning)
    console.warn('[imageProcessor] Returning original image due to processing error');
    return {
      base64: imageBase64,
      mimeType: imageMimeType,
      sizeKB: Math.round(Buffer.from(imageBase64, 'base64').length / 1024)
    };
  }
}

module.exports = { processImageForGemini };

