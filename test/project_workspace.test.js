// Milestone 13 — Project Workspace Layer Tests

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  normalizeProjectId,
  getWorkspaceRoot,
  ensureWorkspace,
  getActiveWorkspace,
  setActiveWorkspace,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  listWorkspaces,
  resolveWorkspacePath,
  writeWorkspaceArtifact,
  listWorkspaceArtifacts,
  linkRunToWorkspace,
  linkHandoffToWorkspace,
  getWorkspaceSummary
} = require('../src/governor/project_workspace');

const { executeTool } = require('../bin/executor');
const { getAgent, authorizeToolForAgent } = require('../src/governor/agent_registry');
const { buildSystemPrompt } = require('../bin/model_client');
const { setMockCapture } = require('../src/vision/screenshot_capture');
const { saveScreenshot } = require('../src/vision/image_artifact_store');

// Utility to clean up test workspaces
const TEST_PROJECT_ID = 'test-workspace-temp-123';
function cleanupTestWorkspace() {
  try {
    const wsRoot = getWorkspaceRoot();
    const activeTxt = path.join(wsRoot, 'active.txt');
    if (fs.existsSync(activeTxt)) {
      const active = fs.readFileSync(activeTxt, 'utf-8').trim();
      if (active === TEST_PROJECT_ID) {
        fs.unlinkSync(activeTxt);
      }
    }

    const testWsPath = path.join(wsRoot, TEST_PROJECT_ID);
    if (fs.existsSync(testWsPath)) {
      fs.rmSync(testWsPath, { recursive: true, force: true });
    }
  } catch (e) {}
}

test('Project Workspace - normalizeProjectId', () => {
  // Safe input normalization
  assert.equal(normalizeProjectId('My Game Project'), 'my-game-project');
  assert.equal(normalizeProjectId('Local Agent Harness'), 'local-agent-harness');
  assert.equal(normalizeProjectId('  Trim-Me  '), 'trim-me');
  assert.equal(normalizeProjectId('Upper_CASE-123'), 'upper_case-123');

  // Rejects empty/invalid
  assert.throws(() => normalizeProjectId(''), /must be a non-empty string/);
  assert.throws(() => normalizeProjectId('   '), /must be a non-empty string/);
  assert.throws(() => normalizeProjectId(123), /must be a non-empty string/);

  // Safeguard: Strict path traversal rejection before normalization
  assert.throws(() => normalizeProjectId('../bad'), /directory traversal or separator characters/);
  assert.throws(() => normalizeProjectId('..\\bad'), /directory traversal or separator characters/);
  assert.throws(() => normalizeProjectId('foo/bar'), /directory traversal or separator characters/);
  assert.throws(() => normalizeProjectId('foo\\bar'), /directory traversal or separator characters/);
  assert.throws(() => normalizeProjectId('a/../b'), /directory traversal or separator characters/);
});

test('Project Workspace - ensureWorkspace layout and default files', () => {
  cleanupTestWorkspace();
  const wsPath = ensureWorkspace(TEST_PROJECT_ID, {
    name: 'Test Project',
    description: 'A test workspace.',
    goal: 'Pass unit tests',
    constraints: ['Constraint A']
  });

  assert.ok(fs.existsSync(wsPath));
  assert.ok(fs.existsSync(path.join(wsPath, 'project.json')));
  assert.ok(fs.existsSync(path.join(wsPath, 'project.md')));
  assert.ok(fs.existsSync(path.join(wsPath, 'goals.md')));
  assert.ok(fs.existsSync(path.join(wsPath, 'constraints.md')));

  // Subfolders
  const subfolders = ['tasks', 'plans', 'handoffs', 'artifacts', 'screenshots', 'runs', 'scratch', 'checkpoints'];
  for (const sub of subfolders) {
    assert.ok(fs.existsSync(path.join(wsPath, sub)));
  }

  // Verify project.json
  const manifest = loadWorkspaceManifest(TEST_PROJECT_ID);
  assert.equal(manifest.projectId, TEST_PROJECT_ID);
  assert.equal(manifest.name, 'Test Project');
  assert.equal(manifest.description, 'A test workspace.');
  assert.equal(manifest.activeGoal, 'Pass unit tests');
  assert.deepEqual(manifest.constraints, ['Constraint A']);

  cleanupTestWorkspace();
});

test('Project Workspace - active state management', () => {
  cleanupTestWorkspace();

  // Initially active workspace might be null or something else
  const originalActive = getActiveWorkspace();

  // Set active
  const activeId = setActiveWorkspace(TEST_PROJECT_ID, { name: 'Active Test' });
  assert.equal(activeId, TEST_PROJECT_ID);
  assert.equal(getActiveWorkspace(), TEST_PROJECT_ID);

  cleanupTestWorkspace();
});

test('Project Workspace - manifest load/save/list', () => {
  cleanupTestWorkspace();
  ensureWorkspace(TEST_PROJECT_ID);

  const manifest = loadWorkspaceManifest(TEST_PROJECT_ID);
  manifest.status = 'completed';
  manifest.activeGoal = 'Done';
  
  const saved = saveWorkspaceManifest(TEST_PROJECT_ID, manifest);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.activeGoal, 'Done');

  const loaded = loadWorkspaceManifest(TEST_PROJECT_ID);
  assert.equal(loaded.status, 'completed');
  assert.equal(loaded.activeGoal, 'Done');

  const list = listWorkspaces();
  const testObj = list.find(w => w.projectId === TEST_PROJECT_ID);
  assert.ok(testObj);
  assert.equal(testObj.name, TEST_PROJECT_ID);

  cleanupTestWorkspace();
});

test('Project Workspace - safe path resolution and artifact writing', () => {
  cleanupTestWorkspace();
  ensureWorkspace(TEST_PROJECT_ID);

  // Safe path resolve
  const resolved = resolveWorkspacePath(TEST_PROJECT_ID, 'tasks/todo.md');
  assert.ok(resolved.endsWith(path.join(TEST_PROJECT_ID, 'tasks', 'todo.md')));

  // Directory traversal checks on path resolution
  assert.throws(() => resolveWorkspacePath(TEST_PROJECT_ID, '../outside.md'), /Directory traversal attempt detected/);
  assert.throws(() => resolveWorkspacePath(TEST_PROJECT_ID, 'tasks/../../outside.md'), /Directory traversal attempt detected/);

  // Write artifact
  const artPath = writeWorkspaceArtifact(TEST_PROJECT_ID, 'artifacts', 'notes.txt', 'Important note');
  assert.ok(fs.existsSync(artPath));
  assert.equal(fs.readFileSync(artPath, 'utf-8'), 'Important note');

  // List artifacts
  const list = listWorkspaceArtifacts(TEST_PROJECT_ID, 'artifacts');
  assert.ok(list.includes('notes.txt'));

  cleanupTestWorkspace();
});

test('Project Workspace - linking runs and handoffs', () => {
  cleanupTestWorkspace();
  ensureWorkspace(TEST_PROJECT_ID);

  // Run link
  linkRunToWorkspace(TEST_PROJECT_ID, 'run_test_id', {
    taskType: 'coding',
    activeAgentId: 'code_editor',
    modelPreset: 'default',
    promptPreview: 'Make a workspace'
  });

  const runFile = path.join(getWorkspaceRoot(), TEST_PROJECT_ID, 'runs', 'run_test_id.json');
  assert.ok(fs.existsSync(runFile));
  const runData = JSON.parse(fs.readFileSync(runFile, 'utf-8'));
  assert.equal(runData.runId, 'run_test_id');
  assert.equal(runData.taskType, 'coding');
  assert.equal(runData.activeAgentId, 'code_editor');

  // Handoff link
  linkHandoffToWorkspace(TEST_PROJECT_ID, {
    id: 'hop_test_id',
    fromAgentId: 'code_editor',
    toAgentId: 'architect',
    reason: 'test'
  });

  const hopFile = path.join(getWorkspaceRoot(), TEST_PROJECT_ID, 'handoffs', 'hop_test_id.json');
  assert.ok(fs.existsSync(hopFile));
  const hopData = JSON.parse(fs.readFileSync(hopFile, 'utf-8'));
  assert.equal(hopData.id, 'hop_test_id');
  assert.equal(hopData.fromAgentId, 'code_editor');

  // Summary
  const summary = getWorkspaceSummary(TEST_PROJECT_ID);
  assert.equal(summary.runCount, 1);
  assert.equal(summary.handoffCount, 1);

  cleanupTestWorkspace();
});

test('Project Workspace - executor tools execution', async () => {
  cleanupTestWorkspace();

  const ctx = {
    _ledgerRunId: 'ledger-run-456',
    currentTaskType: 'coding',
    activeAgent: getAgent('conductor')
  };

  // 1. Create workspace via tool
  const createRes = await executeTool('workspace_create', {
    projectId: TEST_PROJECT_ID,
    name: 'Executor Project',
    goal: 'Automate code'
  }, ctx);

  assert.ok(!createRes.error);
  assert.equal(createRes.projectId, TEST_PROJECT_ID);
  assert.equal(getActiveWorkspace(), TEST_PROJECT_ID);

  // 2. Status tool
  const statusRes = await executeTool('workspace_status', {}, ctx);
  assert.ok(!statusRes.error);
  const statusObj = JSON.parse(statusRes.result);
  assert.equal(statusObj.projectId, TEST_PROJECT_ID);
  assert.equal(statusObj.name, 'Executor Project');

  // 3. Add task tool
  const taskRes = await executeTool('workspace_add_task', {
    title: 'Code feature A',
    content: '- [ ] Write tests'
  }, ctx);
  assert.ok(!taskRes.error);
  assert.ok(taskRes.path.includes('code-feature-a.md'));

  // 4. Add plan tool
  const planRes = await executeTool('workspace_add_plan', {
    title: 'Architecture Plan',
    content: 'Phase 1: DB design'
  }, ctx);
  assert.ok(!planRes.error);
  assert.ok(planRes.path.includes('architecture-plan.md'));

  // 5. Add artifact tool
  const artRes = await executeTool('workspace_add_artifact', {
    name: 'output.log',
    content: 'All tests passed'
  }, ctx);
  assert.ok(!artRes.error);
  assert.equal(artRes.path, 'output.log');

  // 6. Link run tool
  const linkRes = await executeTool('workspace_link_run', {
    runId: 'run-manual-link'
  }, ctx);
  assert.ok(!linkRes.error);

  // Check counts
  const finalSummary = getWorkspaceSummary(TEST_PROJECT_ID);
  assert.equal(finalSummary.taskCount, 1);
  assert.equal(finalSummary.planCount, 1);
  assert.equal(finalSummary.artifactCount, 1);
  assert.equal(finalSummary.runCount, 2); // 1 linked automatically during create, 1 linked manually

  cleanupTestWorkspace();
});

test('Project Workspace - agent registry whitelist permissions', () => {
  const conductor = getAgent('conductor');
  const architect = getAgent('architect');
  const qaTester = getAgent('qa_tester');

  // Conductor gets workspace_create
  const auth1 = authorizeToolForAgent('workspace_create', conductor);
  assert.ok(auth1.authorized);

  // Architect gets workspace_add_plan but NOT workspace_create in strict mode
  const auth2 = authorizeToolForAgent('workspace_add_plan', architect);
  assert.ok(auth2.authorized);

  const auth3 = authorizeToolForAgent('workspace_create', architect, { mode: 'strict' });
  assert.ok(!auth3.authorized);

  // QA Tester gets workspace_status but NOT workspace_create
  const auth4 = authorizeToolForAgent('workspace_status', qaTester);
  assert.ok(auth4.authorized);

  const auth5 = authorizeToolForAgent('workspace_create', qaTester, { mode: 'strict' });
  assert.ok(!auth5.authorized);
});

test('Project Workspace - system prompt context injection', () => {
  cleanupTestWorkspace();
  setActiveWorkspace(TEST_PROJECT_ID, {
    name: 'System Prompt Test',
    goal: 'Verify prompt rendering'
  });

  const mockCtx = {
    config: {},
    conversationHistory: [],
    currentTaskType: 'coding'
  };

  const prompt = buildSystemPrompt(mockCtx);
  assert.ok(prompt.includes('[ACTIVE_WORKSPACE]'));
  assert.ok(prompt.includes(`id: ${TEST_PROJECT_ID}`));
  assert.ok(prompt.includes('name: System Prompt Test'));
  assert.ok(prompt.includes('goal: Verify prompt rendering'));
  assert.ok(prompt.includes('[/ACTIVE_WORKSPACE]'));

  cleanupTestWorkspace();
});

test('Project Workspace - screenshot pointer linking', () => {
  cleanupTestWorkspace();
  setActiveWorkspace(TEST_PROJECT_ID);

  let capturedPath = null;
  setMockCapture((p) => {
    capturedPath = p;
    // Write valid dummy PNG header
    const mockPng = Buffer.alloc(24);
    mockPng.writeUInt8(0x89, 0);
    mockPng.writeUInt8(0x50, 1);
    mockPng.writeUInt8(0x4E, 2);
    mockPng.writeUInt8(0x47, 3);
    mockPng.writeUInt32BE(100, 16);
    mockPng.writeUInt32BE(100, 20);
    fs.writeFileSync(p, mockPng);
    return { success: true, filePath: p };
  });

  try {
    const meta = saveScreenshot();
    assert.ok(meta.imageId.startsWith('img_'));

    // Check pointer file in workspace
    const pointerFile = path.join(getWorkspaceRoot(), TEST_PROJECT_ID, 'screenshots', `${meta.imageId}.json`);
    assert.ok(fs.existsSync(pointerFile));

    const pointerData = JSON.parse(fs.readFileSync(pointerFile, 'utf-8'));
    assert.equal(pointerData.imageId, meta.imageId);
    assert.equal(pointerData.filePath, meta.filePath);
    assert.equal(pointerData.width, 100);

    // Clean up original
    fs.unlinkSync(meta.filePath);
  } finally {
    setMockCapture(null);
    cleanupTestWorkspace();
  }
});
