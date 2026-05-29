// Slice 2F — Runtime memory integration verification
//
// Verifies memory tools execution through:
// 1. bin/executor.js executeTool (runtime path A)
// 2. bin/memory.js executeMemoryTool (runtime path B)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');
const { executeTool } = require('../bin/executor');
const { executeMemoryTool } = require('../bin/memory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice2f-'));
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

// ─────────────────────────────────────────────────────────────────────────────
// Test Path A — executor.js executeTool
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2F - Test Path A: executeTool integration', async () => {
  const rootDir = makeTempDir();
  const memoryStore = new MemoryStore(rootDir);
  memoryStore.init();

  const ctx = { memoryStore };

  // 1. Call memory_remember
  const rememberRes = await executeTool('memory_remember', {
    type: 'gotcha',
    title: 'Avoid circular imports',
    content: 'Do not import modules recursively in JavaScript.',
    tags: ['imports', 'circular'],
  }, ctx);

  assert.ok(rememberRes.result, 'remember must return a result');
  // Match ID from: "Remembered [gotcha] "Avoid circular imports" (id)"
  const idMatch = rememberRes.result.match(/\(([^)]+)\)/);
  assert.ok(idMatch, `Could not extract memory ID from: ${rememberRes.result}`);
  const id = idMatch[1];
  assert.ok(id, 'Memory ID must be non-empty');

  // Verify the SQLite row exists directly and uses the same ID
  const sqliteRow = memoryStore.sqliteStore.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.ok(sqliteRow, 'SQLite row must be present');
  assert.equal(sqliteRow.title, 'Avoid circular imports');
  assert.equal(sqliteRow.category, 'gotcha');

  // 2. Call memory_load
  const loadRes = await executeTool('memory_load', { task: 'circular imports issue' }, ctx);
  assert.ok(loadRes.result);
  assert.ok(loadRes.result.includes('Avoid circular imports'), `Output should contain title: ${loadRes.result}`);
  assert.ok(loadRes.result.includes('Do not import modules recursively'), `Output should contain content: ${loadRes.result}`);

  // 3. Call memory_list (all)
  const listAllRes = await executeTool('memory_list', {}, ctx);
  assert.ok(listAllRes.result);
  assert.ok(listAllRes.result.includes(`[${id}] (gotcha) Avoid circular imports`));

  // 4. Call memory_list with category filter
  const listFilteredRes = await executeTool('memory_list', { type: 'gotcha' }, ctx);
  assert.ok(listFilteredRes.result);
  assert.ok(listFilteredRes.result.includes(`[${id}] (gotcha) Avoid circular imports`));

  // Verify category filter works by requesting another type
  const listEmptyRes = await executeTool('memory_list', { type: 'decision' }, ctx);
  assert.equal(listEmptyRes.result, 'No memory stored.');

  // 5. Call memory_forget
  const forgetRes = await executeTool('memory_forget', { id }, ctx);
  assert.equal(forgetRes.result, `Deleted ${id}`);

  // Verify SQLite row is deleted
  const sqliteRowAfter = memoryStore.sqliteStore.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.ok(!sqliteRowAfter, 'SQLite row must be deleted');

  // Verify sidecar markdown file is removed
  const mdFile = path.join(rootDir, '.smallcode/memory', `gotcha-${id}.md`);
  assert.ok(!fs.existsSync(mdFile), 'Markdown sidecar must be unlinked');

  // Verify memory_load no longer returns it
  const loadAfterRes = await executeTool('memory_load', { task: 'circular imports' }, ctx);
  assert.equal(loadAfterRes.result, 'No relevant memory found.');

  memoryStore.sqliteStore.close();
  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Path B — bin/memory.js executeMemoryTool
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2F - Test Path B: executeMemoryTool MCP integration', async () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // 1. Call memory_remember via MCP
  const rememberRes = executeMemoryTool(store, 'memory_remember', {
    type: 'convention',
    title: 'Indent two spaces',
    content: 'Always use 2 spaces indentation in JavaScript.',
    tags: ['indentation', 'spaces'],
  });

  assert.ok(rememberRes.result);
  // Match ID from: "Remembered [convention] "Indent two spaces" (id: <id>)"
  const idMatch = rememberRes.result.match(/id:\s*([^)]+)/);
  assert.ok(idMatch, `Could not extract memory ID from: ${rememberRes.result}`);
  const id = idMatch[1].trim();
  assert.ok(id, 'Memory ID must be non-empty');

  // Verify the SQLite row exists directly and uses the same ID
  const sqliteRow = store.sqliteStore.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.ok(sqliteRow, 'SQLite row must be present');
  assert.equal(sqliteRow.title, 'Indent two spaces');
  assert.equal(sqliteRow.category, 'convention');

  // 2. Call memory_load via MCP
  const loadRes = executeMemoryTool(store, 'memory_load', { task: 'indentation style spaces' });
  assert.ok(loadRes.result);
  assert.ok(loadRes.result.includes('Indent two spaces'));

  // 3. Call memory_list via MCP
  const listAllRes = executeMemoryTool(store, 'memory_list', {});
  assert.ok(listAllRes.result);
  assert.ok(listAllRes.result.includes(`[${id}] (convention) Indent two spaces`));

  const listFilteredRes = executeMemoryTool(store, 'memory_list', { type: 'convention' });
  assert.ok(listFilteredRes.result);
  assert.ok(listFilteredRes.result.includes(`[${id}] (convention) Indent two spaces`));

  const listEmptyRes = executeMemoryTool(store, 'memory_list', { type: 'gotcha' });
  assert.equal(listEmptyRes.result, 'No memory objects stored.');

  // 4. Call memory_forget via MCP
  const forgetRes = executeMemoryTool(store, 'memory_forget', { id });
  assert.equal(forgetRes.result, `Deleted memory ${id}`);

  // Verify SQLite row is deleted
  const sqliteRowAfter = store.sqliteStore.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.ok(!sqliteRowAfter, 'SQLite row must be deleted');

  // Verify sidecar markdown file is removed
  const mdFile = path.join(rootDir, '.smallcode/memory', `convention-${id}.md`);
  assert.ok(!fs.existsSync(mdFile), 'Markdown sidecar must be unlinked');

  // Verify memory_load no longer returns it
  const loadAfterRes = executeMemoryTool(store, 'memory_load', { task: 'indentation style' });
  assert.equal(loadAfterRes.result, 'No relevant memory found for this task.');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});
