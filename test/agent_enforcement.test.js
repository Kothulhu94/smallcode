// Milestone 5 — Registry-Aware Routing & Tool Enforcement Tests
//
// Verifies:
// 1. resolveAgentForTask maps task types correctly.
// 2. unknown task type falls back to conductor.
// 3. getActiveAgentContext returns expected agent properties.
// 4. loadForTask applies agent memoryBudget and read permissions.
// 5. unauthorized tool is denied in strict mode.
// 6. allowed tool executes normally.
// 7. canEditFiles=false blocks file-write tools in strict mode.
// 8. canRunShell=false blocks shell tools in strict mode.
// 9. warn mode does not break existing execution.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveAgentForTask,
  getActiveAgentContext,
  authorizeToolForAgent,
  classifyTool
} = require('../src/governor/agent_registry');

const { MemoryStore } = require('../bin/memory');
const { executeTool } = require('../bin/executor');

function makeTempDir() {
  const dir = path.join(process.cwd(), `temp_enforcement_test_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) cleanupDir(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(dir);
  } catch {}
}

test('Milestone 5 - resolveAgentForTask mappings', () => {
  // backend -> code_editor
  assert.equal(resolveAgentForTask('backend').id, 'code_editor');
  // coding -> code_editor
  assert.equal(resolveAgentForTask('coding').id, 'code_editor');
  // debugging -> qa_tester
  assert.equal(resolveAgentForTask('debugging').id, 'qa_tester');
  // shell -> qa_tester
  assert.equal(resolveAgentForTask('shell').id, 'qa_tester');
  // search -> repo_navigator
  assert.equal(resolveAgentForTask('search').id, 'repo_navigator');
  // explanation -> repo_navigator
  assert.equal(resolveAgentForTask('explanation').id, 'repo_navigator');
  // architecture -> architect
  assert.equal(resolveAgentForTask('architecture').id, 'architect');
  // design -> architect
  assert.equal(resolveAgentForTask('design').id, 'architect');

  // Fallback to conductor
  assert.equal(resolveAgentForTask('unknown_task_type').id, 'conductor');
  assert.equal(resolveAgentForTask(null).id, 'conductor');
});

test('Milestone 5 - getActiveAgentContext properties', () => {
  const ctx = getActiveAgentContext('coding');
  assert.ok(ctx);
  assert.equal(ctx.agentId, 'code_editor');
  assert.ok(ctx.allowedTools.includes('patch'));
  assert.equal(ctx.modelPreset, 'default');
  assert.equal(ctx.canEditFiles, true);
  assert.equal(ctx.canRunShell, true);
  assert.equal(ctx.requiresApproval, true);
});

test('Milestone 5 - loadForTask integrates agent budget and permissions', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Remember memories with different categories
  store.remember('convention', 'C1', 'Convention Content 1', { tags: ['test'] });
  store.remember('gotcha', 'G1', 'Gotcha Content 1', { tags: ['test'] });
  store.remember('decision', 'D1', 'Decision Content 1', { tags: ['test'] });

  // 1. Task type 'search' maps to repo_navigator (read: ['context', 'decision', 'convention'])
  // Wait! fallback policy context_policy.js has 'search' categories: ['context', 'decision']
  // Load for task should intersect: ['context', 'decision', 'convention'] ∩ ['context', 'decision'] -> ['context', 'decision']
  const searchMems = store.loadForTask('test', 1000, { taskType: 'search' });
  const searchTypes = searchMems.map(m => m.type);
  assert.ok(searchTypes.includes('decision'));
  assert.ok(!searchTypes.includes('convention'), 'Convention must be filtered out by search fallback policy intersection');
  assert.ok(!searchTypes.includes('gotcha'));

  // 2. Task type 'shell' maps to qa_tester (read: ['workflow', 'gotcha'])
  // fallback policy has 'shell' categories: ['workflow', 'gotcha']
  // Intersect: ['workflow', 'gotcha'] ∩ ['workflow', 'gotcha'] -> ['workflow', 'gotcha']
  const shellMems = store.loadForTask('test', 1000, { taskType: 'shell' });
  const shellTypes = shellMems.map(m => m.type);
  assert.ok(shellTypes.includes('gotcha'));
  assert.ok(!shellTypes.includes('decision'));

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Milestone 5 - Tool authorization modes', () => {
  // Strict mode: deny unauthorized tool
  const strictDeny = authorizeToolForAgent('bash', 'search', { mode: 'strict' });
  assert.equal(strictDeny.authorized, false);
  assert.ok(strictDeny.reason.includes('Tool execution denied'));

  // Strict mode: allow whitelisted tool
  const strictAllow = authorizeToolForAgent('search', 'search', { mode: 'strict' });
  assert.equal(strictAllow.authorized, true);

  // Warn mode: warns instead of blocking
  const warnCheck = authorizeToolForAgent('bash', 'search', { mode: 'warn' });
  assert.equal(warnCheck.authorized, true);
  assert.ok(warnCheck.warning.includes('AgentRegistry Warning'));

  // Off mode: ignores all restrictions
  const offCheck = authorizeToolForAgent('bash', 'search', { mode: 'off' });
  assert.equal(offCheck.authorized, true);
  assert.ok(!offCheck.warning);
});

test('Milestone 5 - canEditFiles and canRunShell restrictions in strict mode', () => {
  // repo_navigator has canEditFiles=false and canRunShell=false
  // 1. Block file writing
  const fileCheck = authorizeToolForAgent('write_file', 'search', { mode: 'strict' });
  assert.equal(fileCheck.authorized, false);
  assert.ok(fileCheck.reason.includes('File modifications are not authorized'));

  // 2. Block shell execution
  const shellCheck = authorizeToolForAgent('bash', 'search', { mode: 'strict' });
  assert.equal(shellCheck.authorized, false);
  assert.ok(shellCheck.reason.includes('Tool execution denied'));
});

test('Milestone 5 - executeTool strict/warn enforcement integration', async () => {
  const rootDir = makeTempDir();
  const testFile = path.join(rootDir, 'test.txt');

  // Set environment variable to strict for verification
  process.env.SMALLCODE_ENFORCEMENT_MODE = 'strict';

  const ctx = {
    currentTaskType: 'search', // Maps to repo_navigator (canEditFiles = false, allowedTools: search/explain_symbol/read_file/etc)
    config: {}
  };

  // 1. Attempt unauthorized write_file (denied because canEditFiles is false for repo_navigator)
  const writeRes = await executeTool('write_file', { path: testFile, content: 'hello' }, ctx);
  assert.ok(writeRes.error);
  assert.ok(writeRes.error.includes('File modifications are not authorized'));

  // 2. Attempt unauthorized bash (denied because bash is not whitelisted for repo_navigator)
  const bashRes = await executeTool('bash', { command: 'echo hello' }, ctx);
  assert.ok(bashRes.error);
  assert.ok(bashRes.error.includes('not whitelisted for agent'));

  // 3. Switch taskType to coding -> Maps to code_editor (canEditFiles = true, allowedTools: write_file/patch/etc)
  const ctx2 = {
    currentTaskType: 'coding',
    config: {}
  };
  const writeRes2 = await executeTool('write_file', { path: testFile, content: 'hello success' }, ctx2);
  assert.ok(!writeRes2.error, `Should write successfully: ${writeRes2.error}`);
  assert.equal(fs.readFileSync(testFile, 'utf-8'), 'hello success');

  // Reset enforcement mode
  delete process.env.SMALLCODE_ENFORCEMENT_MODE;

  cleanupDir(rootDir);
});
