// SmallCode — Image Artifact Store
// Manages local screenshot storage, metadata listing, and dependency-free PNG dimension parsing.

const fs = require('fs');
const path = require('path');
const { captureScreenshot } = require('./screenshot_capture');

const SCREENSHOT_DIR = path.join(process.cwd(), '.smallcode', 'screenshots');

function ensureDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * Parses PNG width and height from the PNG binary buffer.
 * PNG IHDR chunk is always at a fixed location:
 * - Bytes 12-15: 'IHDR' (chunk identifier)
 * - Bytes 16-19: Width (32-bit big-endian integer)
 * - Bytes 20-23: Height (32-bit big-endian integer)
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}}
 */
function parsePngDimensions(buffer) {
  if (buffer.length < 24) {
    throw new Error('Invalid PNG buffer: too small');
  }
  // Check PNG signature [137, 80, 78, 71, 13, 10, 26, 10]
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47) {
    throw new Error('Invalid PNG buffer: missing PNG signature');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/**
 * Captures a new desktop screenshot, stores it as an artifact, and returns its metadata.
 * @returns {object} Metadata object
 */
function saveScreenshot() {
  ensureDir();
  const imageId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(SCREENSHOT_DIR, `${imageId}.png`);

  captureScreenshot(filePath);

  const buffer = fs.readFileSync(filePath);
  const { width, height } = parsePngDimensions(buffer);

  const metadata = {
    imageId,
    filePath,
    mimeType: 'image/png',
    width,
    height,
    byteSize: buffer.length,
    createdAt: Date.now()
  };

  try {
    const { getActiveWorkspace, writeWorkspaceArtifact } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (activeId) {
      writeWorkspaceArtifact(activeId, 'screenshots', `${imageId}.json`, JSON.stringify(metadata, null, 2));
    }
  } catch (wsErr) {
    console.warn(`[image_artifact_store] Warning: failed to save workspace pointer for screenshot: ${wsErr.message}`);
  }

  return metadata;
}

/**
 * Lists all stored screenshot artifacts sorted by recency.
 * @returns {Array<object>} List of image metadata objects
 */
function listImages() {
  ensureDir();
  if (!fs.existsSync(SCREENSHOT_DIR)) return [];

  const files = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
  return files.map(file => {
    const filePath = path.join(SCREENSHOT_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const buffer = fs.readFileSync(filePath);
      const { width, height } = parsePngDimensions(buffer);
      return {
        imageId: path.basename(file, '.png'),
        filePath,
        mimeType: 'image/png',
        width,
        height,
        byteSize: stat.size,
        createdAt: stat.mtimeMs
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  saveScreenshot,
  listImages,
  parsePngDimensions,
  SCREENSHOT_DIR
};
