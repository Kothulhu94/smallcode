// Milestone 6A — Run Ledger / Trace Store Unit Tests
//
// Verifies:
// 1.  RunLedger initializes schema and creates all expected tables.
// 2.  startRun() creates a run and returns an ID.
// 3.  endRun() sets status, duration, and token aggregates.
// 4.  recordStep() creates a run_steps row.
// 5.  recordToolCall() creates a tool_calls row with serialized args.
// 6.  recordAuthorization() stores auth events with pass/deny/warn.
// 7.  recordMemoryContext() stores memory context loading events.
// 8.  getRun() returns the run with nested steps, toolCalls, authEvents, memEvents.
// 9.  listRuns() returns runs sorted by recency, with optional status filter.
// 10. getToolStats() aggregates tool call statistics across runs.
// 11. getAuthStats() aggregates authorization denial/warning statistics.
// 12. Ledger is fault-contained — operations on closed/unavailable DB return null/[].
// 13. getLedger() singleton works; resetLedger() cleans up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { RunLedger, getLedger, resetLedger } = require('../src/governor/run_ledger');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ledger-test-'));
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

test('Milestone 6A - RunLedger initializes schema with all tables', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  // Verify all tables exist
  const tables = ledger.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  assert.ok(tables.includes('runs'), 'runs table exists');
  assert.ok(tables.includes('run_steps'), 'run_steps table exists');
  assert.ok(tables.includes('tool_calls'), 'tool_calls table exists');
  assert.ok(tables.includes('authorization_events'), 'authorization_events table exists');
  assert.ok(tables.includes('memory_context_events'), 'memory_context_events table exists');

  ledger.close();
});

test('Milestone 6A - startRun creates a run and returns an ID', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({
    prompt: 'Create a hello world file',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor'
  });

  assert.ok(runId, 'startRun returns an ID');
  assert.ok(typeof runId === 'string');
  assert.ok(runId.length > 0);

  // Verify run is in the database
  const row = ledger.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  assert.ok(row);
  assert.equal(row.prompt, 'Create a hello world file');
  assert.equal(row.model, 'gemma-4');
  assert.equal(row.task_type, 'coding');
  assert.equal(row.agent_id, 'code_editor');
  assert.equal(row.status, 'running');
  assert.ok(row.started_at > 0);

  ledger.close();
});

test('Milestone 6A - endRun sets status, duration, and aggregates', () => {
  const now = 1000000;
  const ledger = new RunLedger({ dbPath: ':memory:', now: () => now });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test', model: 'test-model' });

  // Record two tool calls: one success, one failure
  ledger.recordToolCall({ runId, toolName: 'read_file', success: true, durationMs: 10 });
  ledger.recordToolCall({ runId, toolName: 'bash', success: false, durationMs: 20 });

  // Advance time and end the run
  ledger.config.now = () => now + 5000;
  ledger.endRun(runId, { status: 'completed', promptTokens: 100, completionTokens: 50 });

  const row = ledger.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  assert.equal(row.status, 'completed');
  assert.equal(row.duration_ms, 5000);
  assert.equal(row.tool_count, 2);
  assert.equal(row.error_count, 1);
  assert.equal(row.prompt_tokens, 100);
  assert.equal(row.completion_tokens, 50);

  ledger.close();
});

test('Milestone 6A - recordStep creates run_steps rows', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });

  const stepId1 = ledger.recordStep({
    runId,
    stepIndex: 0,
    stepType: 'tool_call',
    name: 'read_file',
    durationMs: 15,
    success: true,
    summary: 'Read config.json',
  });
  const stepId2 = ledger.recordStep({
    runId,
    stepIndex: 1,
    stepType: 'model_response',
    name: null,
    durationMs: 200,
    success: true,
    summary: 'Model generated code',
  });

  assert.ok(stepId1 !== null);
  assert.ok(stepId2 !== null);

  const steps = ledger.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].step_type, 'tool_call');
  assert.equal(steps[0].name, 'read_file');
  assert.equal(steps[0].success, 1);
  assert.equal(steps[1].step_type, 'model_response');

  ledger.close();
});

test('Milestone 6A - recordToolCall stores args and result summary', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });

  const tcId = ledger.recordToolCall({
    runId,
    stepIndex: 0,
    toolName: 'write_file',
    args: { path: 'hello.txt', content: 'Hello World' },
    resultSummary: 'File written successfully',
    success: true,
    durationMs: 5,
  });

  assert.ok(tcId !== null);

  const row = ledger.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(tcId);
  assert.equal(row.tool_name, 'write_file');
  assert.equal(row.success, 1);
  assert.equal(row.duration_ms, 5);
  assert.ok(row.args_json.includes('hello.txt'));
  assert.ok(row.result_summary.includes('File written successfully'));

  ledger.close();
});

test('Milestone 6A - recordAuthorization stores auth pass/deny/warn events', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });

  // Allowed
  ledger.recordAuthorization({
    runId, toolName: 'read_file', taskType: 'search', agentId: 'repo_navigator',
    mode: 'strict', authorized: true, reason: null,
  });

  // Denied
  ledger.recordAuthorization({
    runId, toolName: 'bash', taskType: 'search', agentId: 'repo_navigator',
    mode: 'strict', authorized: false, reason: 'Tool execution denied: not whitelisted',
  });

  // Warned
  ledger.recordAuthorization({
    runId, toolName: 'bash', taskType: 'search', agentId: 'repo_navigator',
    mode: 'warn', authorized: true, reason: 'Warning: not whitelisted',
  });

  const events = ledger.db.prepare('SELECT * FROM authorization_events WHERE run_id = ?').all(runId);
  assert.equal(events.length, 3);

  const denied = events.find(e => e.authorized === 0);
  assert.ok(denied);
  assert.ok(denied.reason.includes('not whitelisted'));
  assert.equal(denied.mode, 'strict');

  ledger.close();
});

test('Milestone 6A - recordMemoryContext stores memory loading details', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });

  ledger.recordMemoryContext({
    runId, taskType: 'coding', agentId: 'code_editor',
    budgetRequested: 2000, budgetResolved: 1500,
    categoriesAllowed: ['decision', 'convention', 'gotcha'],
    itemsLoaded: 5, tokensUsed: 1200,
  });

  const events = ledger.db.prepare('SELECT * FROM memory_context_events WHERE run_id = ?').all(runId);
  assert.equal(events.length, 1);
  assert.equal(events[0].task_type, 'coding');
  assert.equal(events[0].budget_requested, 2000);
  assert.equal(events[0].budget_resolved, 1500);
  assert.equal(events[0].categories_allowed, 'decision,convention,gotcha');
  assert.equal(events[0].items_loaded, 5);
  assert.equal(events[0].tokens_used, 1200);

  ledger.close();
});

test('Milestone 6A - getRun returns full run with nested children', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'full test', model: 'test-model', taskType: 'coding' });

  ledger.recordStep({ runId, stepIndex: 0, stepType: 'tool_call', name: 'read_file' });
  ledger.recordToolCall({ runId, stepIndex: 0, toolName: 'read_file', success: true });
  ledger.recordAuthorization({ runId, toolName: 'read_file', authorized: true, mode: 'warn' });
  ledger.recordMemoryContext({ runId, taskType: 'coding', itemsLoaded: 3 });

  ledger.endRun(runId, { status: 'completed' });

  const run = ledger.getRun(runId);
  assert.ok(run);
  assert.equal(run.id, runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.prompt, 'full test');
  assert.ok(Array.isArray(run.steps));
  assert.equal(run.steps.length, 1);
  assert.ok(Array.isArray(run.toolCalls));
  assert.equal(run.toolCalls.length, 1);
  assert.ok(Array.isArray(run.authEvents));
  assert.equal(run.authEvents.length, 1);
  assert.ok(Array.isArray(run.memEvents));
  assert.equal(run.memEvents.length, 1);

  // Non-existent run returns null
  assert.equal(ledger.getRun('nonexistent'), null);

  ledger.close();
});

test('Milestone 6A - listRuns returns sorted runs with status filter', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  let time = 1000000;
  ledger.config.now = () => time;
  ledger.init();

  // Create three runs at different times
  time = 1000000;
  const r1 = ledger.startRun({ prompt: 'first' });
  time = 2000000;
  const r2 = ledger.startRun({ prompt: 'second' });
  time = 3000000;
  const r3 = ledger.startRun({ prompt: 'third' });

  // End two runs
  ledger.endRun(r1, { status: 'completed' });
  ledger.endRun(r3, { status: 'error' });

  // List all
  const all = ledger.listRuns();
  assert.equal(all.length, 3);
  assert.equal(all[0].id, r3, 'Most recent first');
  assert.equal(all[1].id, r2);
  assert.equal(all[2].id, r1);

  // Filter by status
  const completed = ledger.listRuns({ status: 'completed' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, r1);

  const running = ledger.listRuns({ status: 'running' });
  assert.equal(running.length, 1);
  assert.equal(running[0].id, r2);

  // Limit
  const limited = ledger.listRuns({ limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, r3);

  ledger.close();
});

test('Milestone 6A - getToolStats aggregates tool call statistics', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const r1 = ledger.startRun({ prompt: 'test1' });
  const r2 = ledger.startRun({ prompt: 'test2' });

  ledger.recordToolCall({ runId: r1, toolName: 'read_file', success: true, durationMs: 10 });
  ledger.recordToolCall({ runId: r1, toolName: 'read_file', success: true, durationMs: 20 });
  ledger.recordToolCall({ runId: r1, toolName: 'write_file', success: true, durationMs: 5 });
  ledger.recordToolCall({ runId: r2, toolName: 'read_file', success: false, durationMs: 30 });
  ledger.recordToolCall({ runId: r2, toolName: 'bash', success: true, durationMs: 100 });

  const stats = ledger.getToolStats();
  assert.equal(stats.totalCalls, 5);
  assert.ok(stats.tools.length >= 3);

  const readFile = stats.tools.find(t => t.tool_name === 'read_file');
  assert.ok(readFile);
  assert.equal(readFile.call_count, 3);
  assert.equal(readFile.success_count, 2);
  assert.ok(readFile.avg_duration_ms === 20); // (10+20+30)/3

  ledger.close();
});

test('Milestone 6A - getAuthStats aggregates authorization statistics', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });

  ledger.recordAuthorization({ runId, toolName: 'bash', agentId: 'repo_navigator', mode: 'strict', authorized: false });
  ledger.recordAuthorization({ runId, toolName: 'bash', agentId: 'repo_navigator', mode: 'strict', authorized: false });
  ledger.recordAuthorization({ runId, toolName: 'read_file', agentId: 'repo_navigator', mode: 'strict', authorized: true });

  const stats = ledger.getAuthStats();
  assert.ok(stats.length >= 1);

  const bashStat = stats.find(s => s.tool_name === 'bash');
  assert.ok(bashStat);
  assert.equal(bashStat.denied_count, 2);
  assert.equal(bashStat.allowed_count, 0);

  ledger.close();
});

test('Milestone 6A - fault containment — closed DB returns null/[]', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'test' });
  assert.ok(runId);

  // Close the DB to simulate failure
  ledger.close();

  // All operations should degrade gracefully
  assert.equal(ledger.startRun({ prompt: 'fail' }), null);
  ledger.endRun(runId); // should not throw
  assert.equal(ledger.recordStep({ runId, stepType: 'test' }), null);
  assert.equal(ledger.recordToolCall({ toolName: 'test', success: true }), null);
  assert.equal(ledger.recordAuthorization({ toolName: 'test', authorized: true }), null);
  assert.equal(ledger.recordMemoryContext({ taskType: 'test' }), null);
  assert.equal(ledger.getRun(runId), null);
  assert.deepEqual(ledger.listRuns(), []);
  assert.deepEqual(ledger.getToolStats(), { tools: [], totalCalls: 0 });
  assert.deepEqual(ledger.getAuthStats(), []);
});

test('Milestone 6A - getLedger singleton and resetLedger', () => {
  // Reset any prior state
  resetLedger();

  const ledger1 = getLedger({ dbPath: ':memory:' });
  const ledger2 = getLedger();

  assert.strictEqual(ledger1, ledger2, 'getLedger returns the same instance');

  // Start a run to verify it works
  const runId = ledger1.startRun({ prompt: 'singleton test' });
  assert.ok(runId);

  // Reset should close and clear
  resetLedger();
  const ledger3 = getLedger({ dbPath: ':memory:' });
  assert.notStrictEqual(ledger3, ledger1, 'After reset, new instance is created');

  resetLedger();
});

test('Milestone 6A - file-based DB persists across instances', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'test_ledger.db');

  // Instance 1: write
  const ledger1 = new RunLedger({ dbPath });
  ledger1.init();
  const runId = ledger1.startRun({ prompt: 'persist test', model: 'gemma-4' });
  ledger1.recordToolCall({ runId, toolName: 'read_file', success: true, durationMs: 10 });
  ledger1.endRun(runId, { status: 'completed' });
  ledger1.close();

  // Instance 2: read
  const ledger2 = new RunLedger({ dbPath });
  ledger2.init();
  const run = ledger2.getRun(runId);
  assert.ok(run);
  assert.equal(run.prompt, 'persist test');
  assert.equal(run.status, 'completed');
  assert.equal(run.toolCalls.length, 1);
  ledger2.close();

  cleanupDir(tmpDir);
});

test('Milestone 6B - startRun saves modelPreset', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({
    prompt: 'Test modelPreset storage',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
    modelPreset: 'strong'
  });

  assert.ok(runId);
  const run = ledger.getRun(runId);
  assert.equal(run.model_preset, 'strong');
  ledger.close();
});

test('Milestone 6B - backward compatibility migration adds model_preset column', () => {
  const tmpDir = makeTempDir();
  const dbPath = path.join(tmpDir, 'old_ledger.db');

  // Create database with old schema (pre-6B)
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      prompt TEXT,
      model TEXT,
      task_type TEXT,
      agent_id TEXT,
      status TEXT DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      tool_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0
    )
  `).run();
  db.close();

  // Load with RunLedger, which should perform the migration
  const ledger = new RunLedger({ dbPath });
  ledger.init(); // This should trigger the ALTER TABLE runs ADD COLUMN model_preset TEXT

  const runId = ledger.startRun({
    prompt: 'Test migration',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
    modelPreset: 'medium'
  });

  assert.ok(runId);
  const run = ledger.getRun(runId);
  assert.equal(run.model_preset, 'medium');

  ledger.close();
  cleanupDir(tmpDir);
});

test('Milestone 7 - RunLedger new read helpers and stats', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({ prompt: 'Read helper test', model: 'gemma-4', taskType: 'coding', agentId: 'code_editor' });
  
  ledger.recordStep({ runId, stepIndex: 0, stepType: 'model_response', name: 'gemma-4', durationMs: 100, success: true, summary: 'OK' });
  ledger.recordToolCall({ runId, stepIndex: 0, toolName: 'read_file', success: true, durationMs: 20 });
  ledger.recordAuthorization({ runId, toolName: 'read_file', taskType: 'coding', agentId: 'code_editor', mode: 'strict', authorized: true });
  ledger.recordMemoryContext({ runId, taskType: 'coding', agentId: 'code_editor', budgetRequested: 800, budgetResolved: 800, itemsLoaded: 2, tokensUsed: 400 });

  ledger.endRun(runId, { status: 'completed', promptTokens: 50, completionTokens: 100 });

  // Test getRunSteps
  const steps = ledger.getRunSteps(runId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].summary, 'OK');

  // Test getToolCalls
  const toolCalls = ledger.getToolCalls(runId);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].tool_name, 'read_file');

  // Test getAuthorizationEvents
  const auths = ledger.getAuthorizationEvents(runId);
  assert.equal(auths.length, 1);
  assert.equal(auths[0].tool_name, 'read_file');

  // Test getMemoryContextEvents
  const mems = ledger.getMemoryContextEvents(runId);
  assert.equal(mems.length, 1);
  assert.equal(mems[0].tokens_used, 400);

  // Test getRunDetail
  const detail = ledger.getRunDetail(runId);
  assert.equal(detail.prompt, 'Read helper test');
  assert.equal(detail.steps.length, 1);

  // Test getStats
  const stats = ledger.getStats();
  assert.equal(stats.totalRuns, 1);
  assert.equal(stats.successCount, 1);
  assert.equal(stats.totalPromptTokens, 50);
  assert.equal(stats.totalCompletionTokens, 100);

  ledger.close();
});
