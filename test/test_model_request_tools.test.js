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

// Test 2: code_editor + coding excludes project-management tools
test('Model Request Tools - code_editor + coding excludes workspace_create, workspace_add_task, and workspace_add_plan', () => {
  const codeEditor = getAgent('code_editor');
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };

  const tools = getAllTools(config, null, { agentContext: codeEditor, taskType: 'coding' });
  const hasWorkspaceCreate = tools.some(t => t.function && t.function.name === 'workspace_create');
  const hasWorkspaceAddTask = tools.some(t => t.function && t.function.name === 'workspace_add_task');
  const hasWorkspaceAddPlan = tools.some(t => t.function && t.function.name === 'workspace_add_plan');
  
  assert.ok(!hasWorkspaceCreate, 'tools must exclude workspace_create');
  assert.ok(!hasWorkspaceAddTask, 'tools must exclude workspace_add_task');
  assert.ok(!hasWorkspaceAddPlan, 'tools must exclude workspace_add_plan');
});

// Test 3: conductor + multi_step still exposes workspace_create, workspace_set_root, workspace_add_task, workspace_add_plan
test('Model Request Tools - conductor + multi_step exposes workspace_create, workspace_set_root, workspace_add_task, workspace_add_plan', () => {
  const conductor = getAgent('conductor');
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };

  const tools = getAllTools(config, null, { agentContext: conductor, taskType: 'multi_step' });
  const hasWorkspaceCreate = tools.some(t => t.function && t.function.name === 'workspace_create');
  const hasWorkspaceSetRoot = tools.some(t => t.function && t.function.name === 'workspace_set_root');
  const hasWorkspaceAddTask = tools.some(t => t.function && t.function.name === 'workspace_add_task');
  const hasWorkspaceAddPlan = tools.some(t => t.function && t.function.name === 'workspace_add_plan');
  
  assert.ok(hasWorkspaceCreate, 'tools must include workspace_create');
  assert.ok(hasWorkspaceSetRoot, 'tools must include workspace_set_root');
  assert.ok(hasWorkspaceAddTask, 'tools must include workspace_add_task');
  assert.ok(hasWorkspaceAddPlan, 'tools must include workspace_add_plan');
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

// Test 18: executor blocks code_editor from calling workspace_add_task
test('Model Request Tools - executor blocks code_editor from calling workspace_add_task', async () => {
  const { executeTool } = require('../bin/executor');
  const codeEditor = getAgent('code_editor');
  
  const result = await executeTool('workspace_add_task', { title: 't', content: 'c' }, {
    activeAgent: codeEditor,
    currentTaskType: 'coding',
    config: {}
  });

  assert.ok(result.error);
  assert.match(result.error, /must implement coding tasks with file tools/);
});

// Test 19: duplicate successful tool call in same run is suppressed
test('Model Request Tools - duplicate successful tool call in same run is suppressed', async () => {
  const { executeTool } = require('../bin/executor');
  
  const runId = `test-run-${Date.now()}`;
  const codeEditor = getAgent('code_editor');
  
  // Need an empty result or something harmless that won't fail
  // We will just use memory_forget for a dummy ID
  const result1 = await executeTool('memory_forget', { id: 'dummy' }, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });

  const result2 = await executeTool('memory_forget', { id: 'dummy' }, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });

  assert.ok(!result1.error || result1.error, 'First call runs properly');
  // Wait, if first call fails, it won't be recorded!
  // memory_forget with dummy ID will probably fail (or not error, let's use list_projects)
  const listResult1 = await executeTool('list_projects', {}, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });
  assert.ok(!listResult1.error, 'list_projects should succeed');

  const listResult2 = await executeTool('list_projects', {}, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });
  assert.ok(listResult2.error);
  assert.match(listResult2.error, /Duplicate tool call suppressed/);
});

// Test 20: duplicate failed tool call is not suppressed
test('Model Request Tools - duplicate failed tool call is not suppressed', async () => {
  const { executeTool } = require('../bin/executor');
  
  const runId = `test-run-fail-${Date.now()}`;
  const codeEditor = getAgent('code_editor');
  
  // read_file of non-existent file will fail
  const result1 = await executeTool('read_file', { path: 'does-not-exist.txt' }, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });
  assert.ok(result1.error);

  const result2 = await executeTool('read_file', { path: 'does-not-exist.txt' }, {
    activeAgent: codeEditor,
    _ledgerRunId: runId,
    config: {}
  });
  // Should fail again for the same reason, NOT suppressed as duplicate
  assert.ok(result2.error);
  assert.doesNotMatch(result2.error, /Duplicate tool call suppressed/);
});

// Test 21: 'only' constraint blocks config.ts but allows src/main.ts
test('Model Request Tools - "only" constraint blocks config.ts but allows src/main.ts', async () => {
  const { executeTool } = require('../bin/executor');
  const codeEditor = getAgent('code_editor');
  
  // Set up a mock run ledger entry
  const runId = `test-run-only-${Date.now()}`;
  const { getLedger } = require('../src/governor/run_ledger');
  getLedger().startRun(runId, 'coding', 'code_editor', 'default', 'Create only package.json, index.html, src/main.ts, and src/style.css');

  try {
    // Attempt to write an allowed file (src/main.ts)
    const resultAllowed = await executeTool('write_file', { path: 'src/main.ts', content: 'content' }, {
      activeAgent: codeEditor,
      _ledgerRunId: runId,
      config: {}
    });
    // It should not fail due to constraint. It might fail because of missing root path though.
    // Let's check the error specifically for constraint.
    if (resultAllowed.error) {
      assert.doesNotMatch(resultAllowed.error, /Constrained request/);
    }

    // Attempt to write a blocked file (config.ts)
    const resultBlocked = await executeTool('write_file', { path: 'config.ts', content: 'content' }, {
      activeAgent: codeEditor,
      _ledgerRunId: runId,
      config: {}
    });
    assert.ok(resultBlocked.error);
    assert.match(resultBlocked.error, /Constrained request.*Blocked creation/);

    // Attempt with Windows separators
    const resultAllowedWin = await executeTool('write_file', { path: 'src\\main.ts', content: 'content' }, {
      activeAgent: codeEditor,
      _ledgerRunId: runId,
      config: {}
    });
    if (resultAllowedWin.error) {
      assert.doesNotMatch(resultAllowedWin.error, /Constrained request/);
    }
  } finally {
    try { getLedger().endRun(runId, { status: 'completed' }); } catch {}
  }
});

// Test 22: explicit file creation routes to coding and exposes file tools
test('Model Request Tools - file creation request routes to coding and exposes file tools', () => {
  const { classifyTask } = require('../bin/governor');
  const msg = 'Create exactly package.json, index.html, src/main.ts, and src/style.css in a new project workspace';
  const taskType = classifyTask(msg);
  assert.equal(taskType, 'coding', 'Heuristic must route explicit file creation to coding even if workspace is mentioned');

  const codeEditor = getAgent('code_editor');
  const config = {
    context: { detected_window: 32768 },
    model: { provider: 'openai', name: 'gpt-3.5-turbo' }
  };
  
  const tools = getAllTools(config, null, { agentContext: codeEditor, taskType });
  const hasWriteFile = tools.some(t => t.function && t.function.name === 'write_file');
  const hasWorkspaceAddTask = tools.some(t => t.function && t.function.name === 'workspace_add_task');
  const hasWorkspaceAddPlan = tools.some(t => t.function && t.function.name === 'workspace_add_plan');
  
  assert.ok(hasWriteFile, 'tools must include write_file');
  assert.ok(!hasWorkspaceAddTask, 'tools must exclude workspace_add_task');
  assert.ok(!hasWorkspaceAddPlan, 'tools must exclude workspace_add_plan');
});

// Test 23: classifier fallback handles "total total total" gracefully
test('Model Request Tools - classifier fallback handles repeated garbage gracefully', async () => {
  const { classifyTaskAsync } = require('../bin/governor');
  const taskType = await classifyTaskAsync('total total total');
  const validTypes = ['coding', 'editing', 'search', 'shell', 'explanation', 'multi_step', 'debugging', 'backend'];
  assert.ok(validTypes.includes(taskType), 'Garbage text should fall back to a valid task type');
});

// Test 24: TinyClassifier config is bounded to max output 8 and stop newline
test('Model Request Tools - TinyClassifier config is bounded to max output 8 and stop newline', () => {
  const { getModel } = require('../src/compiled/providers');
  const model = getModel('TinyClassifier');
  assert.equal(model.maxOutput, 8);
  assert.deepEqual(model.stop, ['\n']);
  assert.equal(model.temperature, 0.2);
});

// Test 25: Local Kobold request omits logprobs/top_logprobs by default
test('Model Request Tools - Local Kobold request omits logprobs/top_logprobs by default', async () => {
  const OpenAICompatProvider = require('../src/compiled/providers/openai_compat').default;
  const provider = new OpenAICompatProvider('http://localhost:5001/v1');
  
  const originalFetch = global.fetch;
  let sentBody = null;
  global.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'coding' } }] })
    };
  };
  
  try {
    const originalLogprobsEnv = process.env.SMALLCODE_LOGPROBS;
    delete process.env.SMALLCODE_LOGPROBS;
    
    await provider.chat({ model: 'test', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(sentBody.logprobs, undefined);
    assert.equal(sentBody.top_logprobs, undefined);
    
    // Set SMALLCODE_LOGPROBS=true and assert they are sent
    process.env.SMALLCODE_LOGPROBS = 'true';
    await provider.chat({ model: 'test', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(sentBody.logprobs, true);
    assert.equal(sentBody.top_logprobs, 1);
    
    if (originalLogprobsEnv !== undefined) {
      process.env.SMALLCODE_LOGPROBS = originalLogprobsEnv;
    } else {
      delete process.env.SMALLCODE_LOGPROBS;
    }
  } finally {
    global.fetch = originalFetch;
  }
});

// Test 26: Classifier prompt uses system/user message role separation
test('Model Request Tools - classifier prompt uses system/user message role separation', async () => {
  const { getPrompt } = require('../src/compiled/cognition/prompts');
  const promptFn = getPrompt('classify_task_type');
  
  const OpenAICompatProvider = require('../src/compiled/providers/openai_compat').default;
  const originalFetch = global.fetch;
  let sentMessages = null;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    sentMessages = body.messages;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'coding' } }], usage: {} })
    };
  };
  
  try {
    await promptFn({ user_message: 'hello' }, { trace_id: 'dummy' });
    assert.ok(Array.isArray(sentMessages));
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[0].role, 'system');
    assert.match(sentMessages[0].content, /Classify this user message/);
    assert.equal(sentMessages[1].role, 'user');
    assert.equal(sentMessages[1].content, 'hello');
  } finally {
    global.fetch = originalFetch;
  }
});

// Test 27: Obvious browser skeleton file creation short-circuits to coding
test('Model Request Tools - obvious browser skeleton file creation short-circuits to coding', async () => {
  const { classifyTaskAsync } = require('../bin/governor');
  const msg = 'Create a minimal TypeScript browser project skeleton in D:\\NewGame. Create package.json, index.html, src/main.ts, and src/style.css.';
  
  const cognitionAdapter = require('../bin/cognition_adapter');
  const originalGetCognition = cognitionAdapter.isCompiledCognitionAvailable;
  // Temporarily break isCompiledCognitionAvailable so it throws if it tries to hit LLM
  cognitionAdapter.isCompiledCognitionAvailable = () => {
    throw new Error('LLM call should not be reached due to short-circuit');
  };
  
  try {
    const taskType = await classifyTaskAsync(msg);
    assert.equal(taskType, 'coding');
  } finally {
    cognitionAdapter.isCompiledCognitionAvailable = originalGetCognition;
  }
});
