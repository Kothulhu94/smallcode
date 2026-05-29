'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parsePngDimensions, saveScreenshot, listImages } = require('../src/vision/image_artifact_store');
const { setMockCapture } = require('../src/vision/screenshot_capture');
const { probeVisionSupport } = require('../src/vision/vision_capability_probe');
const { buildVisionPayload, queryVisionModel } = require('../src/vision/vision_payload_builder');
const { getAgent, authorizeToolForAgent } = require('../src/governor/agent_registry');
const { executeTool } = require('../bin/executor');

test('PNG header dimension parsing', () => {
  // Test valid signature and dimensions
  const validBuf = Buffer.alloc(24);
  validBuf.writeUInt8(0x89, 0);
  validBuf.writeUInt8(0x50, 1);
  validBuf.writeUInt8(0x4E, 2);
  validBuf.writeUInt8(0x47, 3);
  validBuf.writeUInt32BE(1280, 16);
  validBuf.writeUInt32BE(720, 20);

  const dims = parsePngDimensions(validBuf);
  assert.equal(dims.width, 1280);
  assert.equal(dims.height, 720);

  // Test buffer too small
  const smallBuf = Buffer.alloc(20);
  assert.throws(() => parsePngDimensions(smallBuf), /too small/);

  // Test invalid PNG signature
  const badSigBuf = Buffer.alloc(24);
  badSigBuf.writeUInt8(0x00, 0);
  assert.throws(() => parsePngDimensions(badSigBuf), /missing PNG signature/);
});

test('screenshot_capture works with mock capture and image_artifact_store saves metadata', () => {
  let capturedPath = null;
  setMockCapture((p) => {
    capturedPath = p;
    // Write valid dummy PNG header
    const mockPng = Buffer.alloc(24);
    mockPng.writeUInt8(0x89, 0);
    mockPng.writeUInt8(0x50, 1);
    mockPng.writeUInt8(0x4E, 2);
    mockPng.writeUInt8(0x47, 3);
    mockPng.writeUInt32BE(1920, 16);
    mockPng.writeUInt32BE(1080, 20);
    fs.writeFileSync(p, mockPng);
    return { success: true, filePath: p };
  });

  try {
    const meta = saveScreenshot();
    assert.ok(meta.imageId.startsWith('img_'));
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
    assert.equal(meta.mimeType, 'image/png');
    assert.ok(fs.existsSync(meta.filePath));
    assert.equal(capturedPath, meta.filePath);

    // Verify listImages includes the file
    const list = listImages();
    assert.ok(list.length > 0);
    assert.equal(list[0].imageId, meta.imageId);

    // Clean up
    fs.unlinkSync(meta.filePath);
  } finally {
    setMockCapture(null);
  }
});

test('missing Python/Pillow returns structured error', () => {
  const cp = require('child_process');
  const originalSpawnSync = cp.spawnSync;

  // 1. Simulator: Pillow is missing
  cp.spawnSync = () => {
    return {
      status: 2,
      stderr: 'ERROR: Pillow is not installed',
      error: null
    };
  };

  try {
    setMockCapture(null);
    const { captureScreenshot } = require('../src/vision/screenshot_capture');
    assert.throws(() => captureScreenshot('dummy_out.png'), /Pillow\/PIL library/);
  } finally {
    cp.spawnSync = originalSpawnSync;
  }

  // 2. Simulator: Python is missing (ENOENT)
  cp.spawnSync = () => {
    return {
      error: { code: 'ENOENT', message: 'spawnSync python ENOENT' }
    };
  };

  try {
    setMockCapture(null);
    const { captureScreenshot } = require('../src/vision/screenshot_capture');
    assert.throws(() => captureScreenshot('dummy_out.png'), /Python executable not found/);
  } finally {
    cp.spawnSync = originalSpawnSync;
  }
});

test('vision_capability_probe returns correct results for known/unknown configurations', () => {
  // Explicit configuration overrides
  assert.equal(probeVisionSupport({ activeModelTarget: { vision: true } }).supported, true);
  assert.equal(probeVisionSupport({ activeModelTarget: { supports_vision: false } }).supported, false);
  assert.equal(probeVisionSupport({ activeModelTarget: { supportsVision: true } }).supported, true);

  // Provider heuristics
  assert.equal(probeVisionSupport({ activeModelTarget: { provider: 'anthropic', model: 'claude-3' } }).supported, true);

  // Model name heuristics
  assert.equal(probeVisionSupport({ activeModelTarget: { model: 'gpt-4o' } }).supported, true);
  assert.equal(probeVisionSupport({ activeModelTarget: { model: 'gemma-4' } }).supported, true);
  assert.equal(probeVisionSupport({ activeModelTarget: { model: 'pixtral-12b' } }).supported, true);

  // Unrecognized fallback
  assert.equal(probeVisionSupport({ activeModelTarget: { model: 'my-custom-model', provider: 'custom' } }).supported, false);
});

test('vision_payload_builder creates expected OpenAI-style image payload', () => {
  const tempFile = path.join(__dirname, 'temp_test_img.png');
  fs.writeFileSync(tempFile, 'dummy_data');

  try {
    const payload = buildVisionPayload('what is this?', tempFile);
    assert.equal(payload.length, 2);
    assert.equal(payload[0].type, 'text');
    assert.equal(payload[0].text, 'what is this?');
    assert.equal(payload[1].type, 'image_url');
    assert.ok(payload[1].image_url.url.startsWith('data:image/png;base64,'));
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('unsupported provider returns required JSON shape', async () => {
  const tempFile = path.join(__dirname, 'temp_test_img.png');
  fs.writeFileSync(tempFile, 'dummy_data');

  try {
    const config = { activeModelTarget: { model: 'text-only-model', provider: 'ollama', vision: false } };
    const res = await queryVisionModel({ text: 'describe', imagePath: tempFile, config });

    assert.equal(res.error, "Vision input is not supported by the active model endpoint");
    assert.equal(res.imagePath, tempFile);
    assert.equal(res.hint, "Screenshot was captured/stored, but the active model endpoint cannot analyze images.");
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

test('model client returns structured unsupported JSON when vision is disabled but images are referenced', async () => {
  const dummyImgPath = path.join(process.cwd(), 'test_screenshot.png');
  fs.writeFileSync(dummyImgPath, 'dummy_data');

  try {
    const { chatCompletion } = require('../bin/model_client');
    const ctx = {
      config: {
        model: { name: 'text-only-model', baseUrl: 'http://localhost:11434/v1', provider: 'ollama' },
        activeModelTarget: { model: 'text-only-model', provider: 'ollama', vision: false }
      },
      conversationHistory: [
        { role: 'user', content: 'Please check the screenshot @test_screenshot.png' }
      ],
      getAllTools: () => []
    };

    const res = await chatCompletion(ctx);
    assert.ok(res);
    assert.equal(res.error, "Vision input is not supported by the active model endpoint");
    assert.equal(res.imagePath, 'test_screenshot.png');
    assert.equal(res.hint, "Screenshot was captured/stored, but the active model endpoint cannot analyze images.");
  } finally {
    if (fs.existsSync(dummyImgPath)) fs.unlinkSync(dummyImgPath);
  }
});

test('agent registry includes vision tools and visual_observer agent definition', () => {
  const observer = getAgent('visual_observer');
  assert.ok(observer);
  assert.equal(observer.name, 'Visual Observer');
  assert.ok(observer.allowedTools.includes('vision_screenshot'));
  assert.ok(observer.allowedTools.includes('vision_describe'));
  assert.ok(observer.allowedTools.includes('vision_ask'));
  assert.ok(observer.allowedTools.includes('vision_list'));

  const conductor = getAgent('conductor');
  assert.ok(conductor.allowedTools.includes('vision_screenshot'));
  assert.ok(conductor.allowedTools.includes('vision_ask'));
  assert.ok(!conductor.allowedTools.includes('vision_describe'));
});

test('tool enforcement allows/denies vision tools correctly', () => {
  // Conductor allows vision_screenshot, denies vision_describe in strict mode
  const auth1 = authorizeToolForAgent('vision_screenshot', 'multi_step', { mode: 'strict' });
  assert.ok(auth1.authorized);

  const auth2 = authorizeToolForAgent('vision_describe', 'multi_step', { mode: 'strict' });
  assert.equal(auth2.authorized, false);

  // visual_observer allows both
  const visualObserverCtx = { agentId: 'visual_observer', allowedTools: ['vision_screenshot', 'vision_describe'] };
  const auth3 = authorizeToolForAgent('vision_screenshot', visualObserverCtx, { mode: 'strict' });
  assert.ok(auth3.authorized);

  const auth4 = authorizeToolForAgent('vision_describe', visualObserverCtx, { mode: 'strict' });
  assert.ok(auth4.authorized);
});

test('executor handles vision tool routing and execution', async () => {
  setMockCapture((p) => {
    const mockPng = Buffer.alloc(24);
    mockPng.writeUInt8(0x89, 0);
    mockPng.writeUInt8(0x50, 1);
    mockPng.writeUInt8(0x4E, 2);
    mockPng.writeUInt8(0x47, 3);
    mockPng.writeUInt32BE(800, 16);
    mockPng.writeUInt32BE(600, 20);
    fs.writeFileSync(p, mockPng);
    return { success: true, filePath: p };
  });

  try {
    const ctx = {
      activeAgent: getAgent('visual_observer'),
      config: { activeModelTarget: { model: 'gemma-4-it', vision: true } }
    };

    const res = await executeTool('vision_screenshot', {}, ctx);
    assert.equal(res.action, 'Captured');
    assert.equal(res.width, 800);
    assert.equal(res.height, 600);
    assert.ok(fs.existsSync(res.filePath));

    fs.unlinkSync(res.filePath);
  } finally {
    setMockCapture(null);
  }
});
