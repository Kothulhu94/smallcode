// Milestone 8 — Specialist Agent Dispatch & Execution Unit Tests
//
// Verifies:
// 1. Task types resolve to the correct specialist agents.
// 2. getActiveAgentContext returns the full agent context packet.
// 3. authorizeToolForAgent accepts activeAgent object directly.
// 4. Memory store loadForTask uses activeAgent directly.
// 5. Prompt generator (buildSystemPrompt) contains compact agent identity.
// 6. Ledger runs and step logs store agentId, modelPreset, and agent_dispatch step type.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveAgentForTask,
  getActiveAgentContext,
  authorizeToolForAgent
} = require('../src/governor/agent_registry');

const { MemoryStore } = require('../bin/memory');
const { RunLedger } = require('../src/governor/run_ledger');
const { buildSystemPrompt } = require('../bin/model_client');

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `temp_dispatch_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
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

test('Milestone 8 - Task type resolves to correct agent', () => {
  // coding/backend/editing resolve to code_editor
  assert.equal(resolveAgentForTask('coding').id, 'code_editor');
  assert.equal(resolveAgentForTask('backend').id, 'code_editor');
  assert.equal(resolveAgentForTask('editing').id, 'code_editor');

  // shell/debugging resolve to qa_tester
  assert.equal(resolveAgentForTask('shell').id, 'qa_tester');
  assert.equal(resolveAgentForTask('debugging').id, 'qa_tester');

  // search/explanation resolve to repo_navigator
  assert.equal(resolveAgentForTask('search').id, 'repo_navigator');
  assert.equal(resolveAgentForTask('explanation').id, 'repo_navigator');

  // architecture/design resolve to architect
  assert.equal(resolveAgentForTask('architecture').id, 'architect');
  assert.equal(resolveAgentForTask('design').id, 'architect');

  // unknown taskType falls back to conductor
  assert.equal(resolveAgentForTask('unknown_type').id, 'conductor');
  assert.equal(resolveAgentForTask(null).id, 'conductor');
});

test('Milestone 8 - getActiveAgentContext returns full packet', () => {
  const ctx = getActiveAgentContext('coding');
  assert.ok(ctx);
  assert.equal(ctx.agentId, 'code_editor');
  assert.equal(ctx.name, 'Code Editor');
  assert.equal(ctx.description, 'Applies code changes, updates files, and writes scripts.');
  assert.equal(ctx.modelPreset, 'default');
  assert.equal(typeof ctx.contextBudget, 'number');
  assert.equal(typeof ctx.memoryBudget, 'number');
  assert.ok(ctx.memoryPermissions && Array.isArray(ctx.memoryPermissions.read));
  assert.ok(Array.isArray(ctx.allowedTools));
  assert.equal(ctx.canEditFiles, true);
  assert.equal(ctx.canRunShell, true);
  assert.equal(ctx.requiresApproval, true);
});

test('Milestone 8 - authorizeToolForAgent accepts activeAgent object directly', () => {
  const agentCtx = getActiveAgentContext('search'); // repo_navigator: allowedTools doesn't have bash, canEditFiles=false
  
  // Test passing activeAgent object directly to check file-writing deny
  const resWrite = authorizeToolForAgent('write_file', agentCtx, { mode: 'strict' });
  assert.equal(resWrite.authorized, false);
  assert.ok(resWrite.reason.includes('File modifications are not authorized'));

  // Test passing activeAgent object directly to check shell execution deny
  const resBash = authorizeToolForAgent('bash', agentCtx, { mode: 'strict' });
  assert.equal(resBash.authorized, false);
  assert.ok(resBash.reason.includes('not whitelisted for agent'));

  // Test passing activeAgent object directly to check whitelist tool allow
  const resRead = authorizeToolForAgent('read_file', agentCtx, { mode: 'strict' });
  assert.equal(resRead.authorized, true);
});

test('Milestone 8 - memory load policy can use activeAgent object directly', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Remember memories with different categories
  store.remember('convention', 'C1', 'Convention Content 1', { tags: ['test'] });
  store.remember('decision', 'D1', 'Decision Content 1', { tags: ['test'] });
  store.remember('gotcha', 'G1', 'Gotcha Content 1', { tags: ['test'] });

  const agentCtx = getActiveAgentContext('search'); // repo_navigator: read permissions include context, decision, convention
  
  const mems = store.loadForTask('test', 1000, { activeAgent: agentCtx });
  assert.ok(mems.length > 0);
  const types = mems.map(m => m.type);
  assert.ok(types.includes('decision'), 'Decision allowed and loaded');
  assert.ok(types.includes('convention'), 'Convention allowed and loaded');
  assert.ok(!types.includes('gotcha'), 'Gotcha filtered out by agent permissions');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Milestone 8 - buildSystemPrompt contains compact active agent identity', () => {
  const agentCtx = getActiveAgentContext('coding'); // Maps to code_editor
  const mockCtx = {
    config: {},
    conversationHistory: [],
    currentTaskType: 'coding',
    activeAgent: agentCtx,
    getAllTools: () => [],
  };

  const prompt = buildSystemPrompt(mockCtx);
  assert.ok(prompt.includes('[ACTIVE_AGENT]'));
  assert.ok(prompt.includes('id: code_editor'));
  assert.ok(prompt.includes('name: Code Editor'));
  assert.ok(prompt.includes('role: Applies code changes, updates files, and writes scripts.'));
  assert.ok(prompt.includes('[/ACTIVE_AGENT]'));
});

test('Milestone 8 - ledger run or step records agentId/modelPreset where practical', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({
    prompt: 'test prompt',
    model: 'test-model',
    taskType: 'coding',
    agentId: 'code_editor',
    modelPreset: 'default'
  });

  assert.ok(runId);
  const run = ledger.getRun(runId);
  assert.equal(run.agent_id, 'code_editor');
  assert.equal(run.model_preset, 'default');

  ledger.recordStep({
    runId,
    stepIndex: 0,
    stepType: 'agent_dispatch',
    name: 'Code Editor',
    summary: 'Dispatched to Code Editor'
  });

  const steps = ledger.getRunSteps(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step_type, 'agent_dispatch');
  assert.equal(steps[0].name, 'Code Editor');

  ledger.close();
});
