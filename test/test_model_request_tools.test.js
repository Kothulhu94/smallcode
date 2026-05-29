// /test_model_request_tools.test.js
//
// Verifies:
// 1. getAllTools() fallback prevents empty tool list when category-filtered tools and agent tools have no overlap.
// 2. select_category survives agent filtering in two-stage mode.
// 3. final request body includes a tools array when getAllTools() returns non-empty tools.
// 4. final request body includes workspace_create for multi_step / conductor.
// 5. final request body excludes workspace_create for shell / qa_tester.
// 6. if tools are disabled, the request builder exposes a clear reason in testable form.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { buildChatRequestBody, getAllTools } = require('../bin/smallcode');
const { getAgent } = require('../src/governor/agent_registry');
const { providerRegistry } = require('../src/compiled/providers/registry');

function createTestContext(testWsId) {
  const { getWorkspaceRoot } = require('../src/governor/project_workspace');
  const wsRoot = getWorkspaceRoot();
  const activeTxtPath = path.join(wsRoot, 'active.txt');
  
  let originalActiveVal = null;
  if (fs.existsSync(activeTxtPath)) {
    originalActiveVal = fs.readFileSync(activeTxtPath, 'utf-8').trim();
  }

  // Pre-clean folder
  try {
    const wsPath = path.join(wsRoot, testWsId);
    if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
  } catch {}

  return {
    cleanup: () => {
      try {
        if (originalActiveVal) {
          fs.writeFileSync(activeTxtPath, originalActiveVal, 'utf-8');
        } else {
          if (fs.existsSync(activeTxtPath)) {
            const currentActive = fs.readFileSync(activeTxtPath, 'utf-8').trim();
            if (currentActive === testWsId) {
              fs.unlinkSync(activeTxtPath);
            }
          }
        }
        const wsPath = path.join(wsRoot, testWsId);
        if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('Model Request Tools - select_category survives agent filtering in two-stage mode', () => {
  // force two-stage routing mode by contextWindow <= 16384
  const config = {
    context: { detected_window: 8192 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const conductor = getAgent('conductor');
  assert.ok(conductor, 'conductor agent must exist');

  // Stage 1 (stage2Category = null) should return select_category
  const tools = getAllTools(config, null, { agentContext: conductor });
  assert.ok(tools.length > 0, 'Tools should not be empty');
  
  const hasSelectCategory = tools.some(t => t.function && t.function.name === 'select_category');
  assert.ok(hasSelectCategory, 'select_category must be present in two-stage mode turn 1');
});

test('Model Request Tools - getAllTools fallback prevents empty tool list when category-filtered tools and agent tools have no overlap', () => {
  const conductor = getAgent('conductor');
  assert.ok(conductor, 'conductor agent must exist');

  // Test Case A: two-stage mode (contextWindow <= 16384)
  // category 'write' has tools like write_file, patch etc. None are allowed for conductor.
  // The fallback should kick in and return select_category (so it can re-select).
  const configTwoStage = {
    context: { detected_window: 8192 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const toolsTwoStage = getAllTools(configTwoStage, 'write', { agentContext: conductor });
  assert.ok(toolsTwoStage.length > 0, 'Tools list must not be empty in two-stage mode fallback');
  const hasSelectCategory = toolsTwoStage.some(t => t.function && t.function.name === 'select_category');
  assert.ok(hasSelectCategory, 'Should fall back to select_category in two-stage mode when intersection is empty');

  // Test Case B: direct mode (contextWindow > 16384)
  // The fallback should kick in and return all of conductor's allowed tools.
  const configDirect = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const toolsDirect = getAllTools(configDirect, 'write', { agentContext: conductor });
  assert.ok(toolsDirect.length > 0, 'Tools list must not be empty in direct mode fallback');
  const hasWorkspaceCreate = toolsDirect.some(t => t.function && t.function.name === 'workspace_create');
  assert.ok(hasWorkspaceCreate, 'Should fall back to conductor allowed tools including workspace_create in direct mode');
});

test('Model Request Tools - final request body includes a tools array when getAllTools() returns non-empty tools', () => {
  const config = {
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const mockTools = [{ type: 'function', function: { name: 'dummy_tool', description: 'desc', parameters: {} } }];
  
  const { body } = buildChatRequestBody([{ role: 'user', content: 'test' }], mockTools, config);
  assert.ok(Array.isArray(body.tools), 'Request body must contain tools array');
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].function.name, 'dummy_tool');
});

test('Model Request Tools - final request body includes workspace_create for multi_step / conductor', () => {
  const config = {
    context: { detected_window: 32768 }, // direct mode so we get all tools directly
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const conductor = getAgent('conductor');
  
  const tools = getAllTools(config, null, { agentContext: conductor });
  const { body } = buildChatRequestBody([{ role: 'user', content: 'test' }], tools, config);
  
  assert.ok(Array.isArray(body.tools), 'Request body must contain tools array');
  const hasWorkspaceCreate = body.tools.some(t => t.function && t.function.name === 'workspace_create');
  assert.ok(hasWorkspaceCreate, 'Request body for conductor must include workspace_create schema');
});

test('Model Request Tools - final request body excludes workspace_create for shell / qa_tester', () => {
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const qaTester = getAgent('qa_tester');
  
  const tools = getAllTools(config, null, { agentContext: qaTester });
  const { body } = buildChatRequestBody([{ role: 'user', content: 'test' }], tools, config);
  
  // If tools list exists, it should not have workspace_create
  if (body.tools) {
    const hasWorkspaceCreate = body.tools.some(t => t.function && t.function.name === 'workspace_create');
    assert.ok(!hasWorkspaceCreate, 'Request body for qa_tester must NOT include workspace_create schema');
  }
});

test('Model Request Tools - if tools are disabled, the request builder exposes a clear reason in testable form', () => {
  const mockTools = [{ type: 'function', function: { name: 'dummy_tool', description: 'desc', parameters: {} } }];

  // Scenario 1: Disabled in config
  const configDisabled = {
    tools: { disabled: true },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  const { body: bodyDisabled } = buildChatRequestBody([{ role: 'user', content: 'test' }], mockTools, configDisabled);
  assert.equal(bodyDisabled.tools, undefined, 'Request body must not include tools when disabled in config');
  assert.equal(bodyDisabled.__toolsDisabledReason, 'Tools are explicitly disabled in config.');

  // Scenario 2: Disabled by provider capabilities
  const providerName = 'no_tools_provider_test';
  providerRegistry.register(providerName, {
    name: providerName,
    countTokens: (t) => 0,
    chat: async (r) => ({ content: '' })
  }, { tools: false }); // register with tools: false capability

  try {
    const configProvider = {
      model: { provider: providerName, name: 'dummy-model' }
    };
    const { body: bodyProvider } = buildChatRequestBody([{ role: 'user', content: 'test' }], mockTools, configProvider);
    assert.equal(bodyProvider.tools, undefined, 'Request body must not include tools when disabled by provider');
    assert.equal(bodyProvider.__toolsDisabledReason, `Tools are not supported by provider '${providerName}'.`);
  } finally {
    // clean up provider
    providerRegistry.providers.delete(providerName);
    providerRegistry.capabilities.delete(providerName);
  }
});

// Test 1: code_editor + coding exposes write_file and patch
test('Model Request Tools - code_editor + coding exposes write_file and patch', () => {
  const codeEditor = getAgent('code_editor');
  assert.ok(codeEditor, 'code_editor agent must exist');

  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };

  const tools = getAllTools(config, null, { agentContext: codeEditor, taskType: 'coding' });
  
  const hasWriteFile = tools.some(t => t.function && t.function.name === 'write_file');
  const hasPatch = tools.some(t => t.function && t.function.name === 'patch');
  
  assert.ok(hasWriteFile, 'tools must include write_file');
  assert.ok(hasPatch, 'tools must include patch');
});

// Test 2: code_editor + coding excludes workspace_create
test('Model Request Tools - code_editor + coding excludes workspace_create', () => {
  const codeEditor = getAgent('code_editor');
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };

  const tools = getAllTools(config, null, { agentContext: codeEditor, taskType: 'coding' });
  const hasWorkspaceCreate = tools.some(t => t.function && t.function.name === 'workspace_create');
  
  assert.ok(!hasWorkspaceCreate, 'tools must exclude workspace_create');
});

// Test 3: conductor + multi_step still exposes workspace_create and workspace_set_root
test('Model Request Tools - conductor + multi_step exposes workspace_create and workspace_set_root', () => {
  const conductor = getAgent('conductor');
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };

  const tools = getAllTools(config, null, { agentContext: conductor, taskType: 'multi_step' });
  const hasWorkspaceCreate = tools.some(t => t.function && t.function.name === 'workspace_create');
  const hasWorkspaceSetRoot = tools.some(t => t.function && t.function.name === 'workspace_set_root');
  
  assert.ok(hasWorkspaceCreate, 'tools must include workspace_create');
  assert.ok(hasWorkspaceSetRoot, 'tools must include workspace_set_root');
});

// Test 4: workspace_set_root updates active workspace rootPath
test('Model Request Tools - workspace_set_root updates active workspace rootPath', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    getActiveTargetRoot,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-set-root-test';
  
  const ctx = createTestContext(testWsId);
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `ws_set_root_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    ensureWorkspace(testWsId, { name: 'Root Update Test' });
    setActiveWorkspace(testWsId);

    const conductor = getAgent('conductor');
    const executeCtx = { currentTaskType: 'multi_step', activeAgent: conductor, config: {} };

    // Set rootPath using workspace_set_root
    const result = await executeTool('workspace_set_root', {
      rootPath: tempDir,
      createIfMissing: true
    }, executeCtx);

    assert.ok(!result.error, `workspace_set_root failed: ${result.error}`);
    assert.equal(result.rootPath, path.resolve(tempDir));

    const targetRoot = getActiveTargetRoot();
    assert.equal(targetRoot.ok, true);
    assert.equal(targetRoot.rootPath, path.resolve(tempDir));
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 5: workspace_set_root rejects unsafe paths
test('Model Request Tools - workspace_set_root rejects unsafe paths', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-unsafe-test';
  
  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Unsafe Test' });
    setActiveWorkspace(testWsId);

    const conductor = getAgent('conductor');
    const executeCtx = { currentTaskType: 'multi_step', activeAgent: conductor, config: {} };

    // Test case A: relative path
    const resultRel = await executeTool('workspace_set_root', {
      rootPath: './relative/path'
    }, executeCtx);
    assert.ok(resultRel.error, 'relative rootPath must be rejected');

    // Test case B: traversal path
    const resultTraversal = await executeTool('workspace_set_root', {
      rootPath: 'C:\\Windows\\..\\..\\evil'
    }, executeCtx);
    assert.ok(resultTraversal.error, 'traversal rootPath must be rejected');
  } finally {
    ctx.cleanup();
  }
});

// Test 6: write_file with active workspace but missing rootPath fails clearly
test('Model Request Tools - write_file fails clearly when rootPath is missing', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    ensureWorkspace,
    loadWorkspaceManifest,
    saveWorkspaceManifest,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-missing-root';
  
  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Missing Root Test' });
    setActiveWorkspace(testWsId);
    // Manually force manifest rootPath to empty
    const manifest = loadWorkspaceManifest(testWsId);
    manifest.rootPath = '';
    saveWorkspaceManifest(testWsId, manifest);

    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };

    const result = await executeTool('write_file', {
      path: 'test.txt',
      content: 'hello'
    }, executeCtx);

    assert.ok(result.error, 'write_file should fail when rootPath is missing');
    assert.match(result.error, /Active workspace has no target project root set. Set rootPath before writing project files/);
  } finally {
    ctx.cleanup();
  }
});

// Test 7: write_file with valid rootPath writes inside the target root
test('Model Request Tools - write_file with valid rootPath writes inside the target root', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-valid-root-write';
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `ws_valid_write_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Valid Root Test', rootPath: tempDir });
    setActiveWorkspace(testWsId);

    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };

    const result = await executeTool('write_file', {
      path: 'subdir/test.txt',
      content: 'inside target root'
    }, executeCtx);

    assert.ok(!result.error, `write_file failed: ${result.error}`);
    
    const writtenPath = path.join(tempDir, 'subdir/test.txt');
    assert.ok(fs.existsSync(writtenPath), 'file must be written inside target root');
    assert.equal(fs.readFileSync(writtenPath, 'utf-8'), 'inside target root');
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 8: write_file rejects traversal outside target root
test('Model Request Tools - write_file rejects traversal outside target root', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-traversal-write';
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `ws_traversal_write_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Traversal Write Test', rootPath: tempDir });
    setActiveWorkspace(testWsId);

    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };

    // Test A: path traversal using ..
    const resultTraversal = await executeTool('write_file', {
      path: '../evil.txt',
      content: 'traversal attempt'
    }, executeCtx);
    assert.ok(resultTraversal.error, 'write_file must reject traversal paths containing ..');

    // Test B: absolute path outside target root
    const outsideAbs = path.join(os.tmpdir(), `outside_abs_${Date.now()}`);
    const resultOutside = await executeTool('write_file', {
      path: outsideAbs,
      content: 'outside attempt'
    }, executeCtx);
    assert.ok(resultOutside.error, 'write_file must reject absolute paths outside the target root');
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 9: read_file uses target root for relative paths
test('Model Request Tools - read_file uses target root for relative paths', async () => {
  const { executeTool } = require('../bin/executor');
  const {
    setActiveWorkspace,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-valid-root-read';
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `ws_valid_read_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Create a file to read inside the target root
  fs.mkdirSync(path.join(tempDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'subdir/test.txt'), 'read target root file');

  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Valid Read Test', rootPath: tempDir });
    setActiveWorkspace(testWsId);

    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };

    const result = await executeTool('read_file', {
      path: 'subdir/test.txt'
    }, executeCtx);

    assert.ok(!result.error, `read_file failed: ${result.error}`);
    assert.match(result.result, /read target root file/);
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 10: /files shows target project files when rootPath is set
test('Model Request Tools - /files command shows files in workspace when rootPath is set', async () => {
  const {
    setActiveWorkspace,
    ensureWorkspace,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-files-command-active';
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `ws_files_cmd_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  // Write a mock project file to tempDir
  fs.writeFileSync(path.join(tempDir, 'mock_proj_file.txt'), 'content');

  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Files Command Test', rootPath: tempDir });
    setActiveWorkspace(testWsId);

    const createCommandHandler = require('../bin/commands');
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logged.push(args.join(' '));
    };

    const mockRl = { prompt: () => {} };
    const cmdHandler = createCommandHandler({ model: { name: 'test' } }, [], {}, () => {}, () => {}, 3, {}, {}, {});
    await cmdHandler('/files', mockRl);
    console.log = originalLog;

    const outputString = logged.join('\n');
    assert.match(outputString, /Workspace project root/i);
    assert.match(outputString, /mock_proj_file\.txt/);
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 11: /files gives a clear missing-rootPath message when rootPath is missing
test('Model Request Tools - /files command gives clear missing-rootPath message when missing', async () => {
  const {
    setActiveWorkspace,
    ensureWorkspace,
    loadWorkspaceManifest,
    saveWorkspaceManifest,
  } = require('../src/governor/project_workspace');
  const testWsId = 'ws-files-command-missing';
  
  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Files Command Missing Test' });
    setActiveWorkspace(testWsId);
    const manifest = loadWorkspaceManifest(testWsId);
    manifest.rootPath = '';
    saveWorkspaceManifest(testWsId, manifest);

    const createCommandHandler = require('../bin/commands');
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logged.push(args.join(' '));
    };

    const mockRl = { prompt: () => {} };
    const cmdHandler = createCommandHandler({ model: { name: 'test' } }, [], {}, () => {}, () => {}, 3, {}, {}, {});
    await cmdHandler('/files', mockRl);
    console.log = originalLog;

    const outputString = logged.join('\n');
    assert.match(outputString, /Active workspace has no target project root set/);
  } finally {
    ctx.cleanup();
  }
});

// Test 12: active workspace persists across module reload
test('Model Request Tools - active workspace persists across module reload', () => {
  const { setActiveWorkspace, getActiveWorkspace } = require('../src/governor/project_workspace');
  const testWsId = 'ws-persistence-test';
  const ctx = createTestContext(testWsId);
  try {
    setActiveWorkspace(testWsId);
    
    // Clear require cache for project_workspace
    const resolved = require.resolve('../src/governor/project_workspace');
    delete require.cache[resolved];
    
    const { getActiveWorkspace: getActiveWorkspace2 } = require('../src/governor/project_workspace');
    assert.equal(getActiveWorkspace2(), testWsId);
  } finally {
    ctx.cleanup();
  }
});

// Test 13: workspace_set_root succeeds after active workspace reload
test('Model Request Tools - workspace_set_root succeeds after active workspace reload', async () => {
  const { executeTool } = require('../bin/executor');
  const { setActiveWorkspace } = require('../src/governor/project_workspace');
  const testWsId = 'ws-reload-set-root';
  const ctx = createTestContext(testWsId);
  const tempDir = path.join(require('os').tmpdir(), `ws_reload_root_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    setActiveWorkspace(testWsId);
    
    // Reload module
    const resolved = require.resolve('../src/governor/project_workspace');
    delete require.cache[resolved];
    
    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };
    
    const result = await executeTool('workspace_set_root', {
      rootPath: tempDir,
      createIfMissing: true
    }, executeCtx);
    assert.ok(!result.error, `workspace_set_root failed: ${result.error}`);
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 14: workspace_set_root createIfMissing=true creates missing directory
test('Model Request Tools - workspace_set_root createIfMissing=true creates missing directory', async () => {
  const { executeTool } = require('../bin/executor');
  const { setActiveWorkspace } = require('../src/governor/project_workspace');
  const testWsId = 'ws-create-missing-root';
  const ctx = createTestContext(testWsId);
  const tempDir = path.join(require('os').tmpdir(), `ws_missing_dir_${Date.now()}`);
  try {
    setActiveWorkspace(testWsId);
    
    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };
    
    const result = await executeTool('workspace_set_root', {
      rootPath: tempDir,
      createIfMissing: true
    }, executeCtx);
    assert.ok(!result.error);
    assert.ok(fs.existsSync(tempDir));
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 15: workspace_set_root createIfMissing=false rejects missing directory
test('Model Request Tools - workspace_set_root createIfMissing=false rejects missing directory', async () => {
  const { executeTool } = require('../bin/executor');
  const { setActiveWorkspace } = require('../src/governor/project_workspace');
  const testWsId = 'ws-reject-missing-root';
  const ctx = createTestContext(testWsId);
  const tempDir = path.join(require('os').tmpdir(), `ws_missing_dir_${Date.now()}`);
  try {
    setActiveWorkspace(testWsId);
    
    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };
    
    const result = await executeTool('workspace_set_root', {
      rootPath: tempDir,
      createIfMissing: false
    }, executeCtx);
    assert.ok(result.error);
    assert.match(result.error, /does not exist on disk/);
  } finally {
    ctx.cleanup();
  }
});

// Test 16: workspace_status includes rootPath
test('Model Request Tools - workspace_status includes rootPath', async () => {
  const { executeTool } = require('../bin/executor');
  const { setActiveWorkspace } = require('../src/governor/project_workspace');
  const testWsId = 'ws-status-root-test';
  const ctx = createTestContext(testWsId);
  const tempDir = path.join(require('os').tmpdir(), `ws_status_root_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    setActiveWorkspace(testWsId, { rootPath: tempDir });
    
    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };
    
    const result = await executeTool('workspace_status', {}, executeCtx);
    assert.ok(!result.error);
    const summary = JSON.parse(result.result);
    assert.equal(summary.rootPath, tempDir);
    assert.equal(summary.rootPathValid, true);
  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

// Test 17: duplicate workspace names are rejected
test('Model Request Tools - duplicate workspace names are rejected', async () => {
  const { executeTool } = require('../bin/executor');
  const testWsId1 = 'browser-game-test';
  const testWsId2 = 'browser_game_test';
  
  const ctx1 = createTestContext(testWsId1);
  const ctx2 = createTestContext(testWsId2);
  
  try {
    // Create first workspace
    const res1 = await executeTool('workspace_create', {
      projectId: testWsId1,
      name: 'Game'
    }, { currentTaskType: 'multi_step', activeAgent: getAgent('conductor'), config: {} });
    assert.ok(!res1.error);
    
    // Try to create similar name duplicate
    const res2 = await executeTool('workspace_create', {
      projectId: testWsId2,
      name: 'Game 2'
    }, { currentTaskType: 'multi_step', activeAgent: getAgent('conductor'), config: {} });
    
    assert.ok(res2.error);
    assert.match(res2.error, /similar name already exists/);
  } finally {
    ctx1.cleanup();
    ctx2.cleanup();
  }
});
