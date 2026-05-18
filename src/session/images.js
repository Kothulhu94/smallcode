// SmallCode — Image Input Support
// Detect image references in user messages and encode for multimodal models
// Supports: @image.png, @screenshot.jpg, or paths ending in image extensions
//
// Usage: "look at @screenshot.png and fix the layout"
// The image gets encoded as base64 and sent as a vision content part

const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

/**
 * Detect image file references in a message.
 * Returns array of { path, base64, mimeType }
 */
function extractImages(message, cwd) {
  const images = [];
  
  // Match @path references that end in image extensions
  const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;
  const matches = [...message.matchAll(FILE_REGEX)];
  
  for (const match of matches) {
    const rawPath = match[1];
    if (!rawPath) continue;
    
    const ext = path.extname(rawPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    
    const fullPath = path.resolve(cwd, rawPath);
    if (!fs.existsSync(fullPath)) continue;
    
    try {
      const buffer = fs.readFileSync(fullPath);
      const base64 = buffer.toString('base64');
      const mimeType = getMimeType(ext);
      images.push({ path: rawPath, base64, mimeType, size: buffer.length });
    } catch {}
  }
  
  return images;
}

/**
 * Format images as OpenAI vision API content parts.
 */
function formatImagesForAPI(images) {
  return images.map(img => ({
    type: 'image_url',
    image_url: {
      url: `data:${img.mimeType};base64,${img.base64}`,
    },
  }));
}

/**
 * Check if a model likely supports vision (based on name heuristics).
 */
function modelSupportsVision(modelName) {
  const name = modelName.toLowerCase();
  // Most modern models support vision
  return name.includes('vision') ||
    name.includes('gemma-4') ||
    name.includes('gpt-4') ||
    name.includes('gpt-5') ||
    name.includes('claude') ||
    name.includes('qwen') ||
    name.includes('llava') ||
    name.includes('pixtral');
}

function getMimeType(ext) {
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return types[ext] || 'image/png';
}

module.exports = { extractImages, formatImagesForAPI, modelSupportsVision, IMAGE_EXTENSIONS };
