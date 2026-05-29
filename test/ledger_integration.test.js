// Milestone 6B — Ledger Integration Unit Tests
//
// Verifies:
// 1. loadForTask(..., { runId }) records memory context events in the ledger.
// 2. executeTool(...) records tool calls in the ledger when runId is provided.
// 3. Ledger failures (e.g., closed db) during loadForTask / executeTool are contained and do not crash execution.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');
const { executeTool } = require('../bin/executor');
const { getLedger, resetLedger } = require('../src/governor/run_ledger');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ledger-int-'));
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

test('Milestone 6B - loadForTask records memory_context_events in ledger', () => {
  resetLedger();
  const ledger = getLedger({ dbPath: ':memory:' });
  ledger.init();

  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('convention', 'Title 1', 'Content for convention memory', { tags: ['test'] });
  store.remember('decision', 'Title 2', 'Content for decision memory', { tags: ['test'] });

  const runId = ledger.startRun({
    prompt: 'Query memory',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
    modelPreset: 'default'
  });

  assert.ok(runId);

  const results = store.loadForTask('memory query', 1000, {
    taskType: 'coding',
    runId: runId
  });

  assert.ok(results.length > 0);

  const run = ledger.getRun(runId);
  assert.ok(run);
  assert.equal(run.memEvents.length, 1);

  const event = run.memEvents[0];
  assert.equal(event.run_id, runId);
  assert.equal(event.task_type, 'coding');
  assert.equal(event.agent_id, 'code_editor');
  assert.equal(event.budget_requested, 1000);
  assert.ok(event.budget_resolved > 0);
  assert.equal(event.items_loaded, results.length);
  assert.ok(event.tokens_used > 0);
  assert.ok(event.categories_allowed.includes('convention') || event.categories_allowed.includes('decision'));

  ledger.close();
  resetLedger();
  cleanupDir(rootDir);
});

test('Milestone 6B - executeTool records tool calls in ledger', async () => {
  resetLedger();
  const ledger = getLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({
    prompt: 'Query tool',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
  });

  assert.ok(runId);

  const ctx = {
    _ledgerRunId: runId,
    currentTaskType: 'coding',
  };

  const result = await executeTool('read_file', { path: 'nonexistent_test_file.txt' }, ctx);
  assert.ok(result.error);

  const run = ledger.getRun(runId);
  assert.ok(run);
  assert.equal(run.toolCalls.length, 1);

  const tc = run.toolCalls[0];
  assert.equal(tc.tool_name, 'read_file');
  assert.equal(tc.success, 0);
  assert.ok(tc.args_json.includes('nonexistent_test_file.txt'));
  assert.ok(tc.result_summary.includes('File not found') || tc.result_summary.includes('error'));

  ledger.close();
  resetLedger();
});

test('Milestone 6B - ledger failures do not break execution in loadForTask / executeTool', async () => {
  resetLedger();
  const ledger = getLedger({ dbPath: ':memory:' });
  ledger.init();

  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('convention', 'Title 1', 'Content for convention memory', { tags: ['test'] });

  const runId = ledger.startRun({
    prompt: 'Query memory',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
  });

  // Close the ledger to simulate failures
  ledger.close();

  // loadForTask should still succeed without throwing
  const results = store.loadForTask('memory query', 1000, {
    taskType: 'coding',
    runId: runId
  });
  assert.equal(results.length, 1);

  // executeTool should still succeed/return normal error without throwing
  const ctx = {
    _ledgerRunId: runId,
    currentTaskType: 'coding',
  };
  const result = await executeTool('read_file', { path: 'nonexistent_test_file.txt' }, ctx);
  assert.ok(result.error);

  resetLedger();
  cleanupDir(rootDir);
});
