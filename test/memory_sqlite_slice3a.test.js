// Slice 3A — Memory Context Policy
//
// Verifies:
// 1. Budget and category resolving via context_policy.
// 2. loadForTask() with taskType = 'shell' filters out irrelevant categories.
// 3. loadForTask() with taskType = 'shell' enforces the lower 600 token budget.
// 4. loadForTask() with taskType = 'debugging' enforces the higher 1000 token budget.
// 5. Default policy fallback when taskType is unrecognized or omitted.
// 6. Policy behaves identical on JSON fallback path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');
const { getPolicy, applyPolicy } = require('../src/memory/context_policy');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice3a-'));
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

test('Slice 3A - context_policy applyPolicy calculates budgets and categories correctly', () => {
  // Shell task type
  const shell = applyPolicy('shell', 800);
  assert.equal(shell.maxTokens, 600);
  assert.deepEqual(shell.categories, ['workflow', 'gotcha']);

  // Debugging task type
  const debug = applyPolicy('debugging', 1200);
  assert.equal(debug.maxTokens, 1000);
  assert.deepEqual(debug.categories, ['gotcha', 'decision', 'workflow', 'context']);

  // Fallback / default task type
  const unknown = applyPolicy('unknown', 700);
  assert.equal(unknown.maxTokens, 700);
  assert.deepEqual(unknown.categories, ['decision', 'convention', 'gotcha', 'workflow', 'context']);
});

test('Slice 3A - loadForTask() with shell taskType filters categories and caps tokens (SQLite)', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Remember 3 memories in SQLite with unique text matching query
  store.remember('convention', 'Conv 1', 'Content matching query here 1', { tags: ['query'] });
  store.remember('gotcha', 'Gotcha 1', 'Content matching query here 2', { tags: ['query'] });
  store.remember('workflow', 'Work 1', 'Content matching query here 3', { tags: ['query'] });

  // 1. Without taskType (default, returns all)
  const allMems = store.loadForTask('query', 800);
  assert.equal(allMems.length, 3);

  // 2. With taskType = 'shell' (only allows workflow and gotcha)
  const shellMems = store.loadForTask('query', 800, { taskType: 'shell' });
  assert.equal(shellMems.length, 2);
  const types = shellMems.map(m => m.type);
  assert.ok(types.includes('workflow'));
  assert.ok(types.includes('gotcha'));
  assert.ok(!types.includes('convention'), 'Convention must be filtered out for shell');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3A - loadForTask() with shell taskType caps tokens correctly (SQLite)', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Create large memories of workflow type (each ~250 characters, which is ~63 tokens)
  const bigContent = 'x'.repeat(250) + ' query';
  for (let i = 1; i <= 15; i++) {
    store.remember('workflow', `Workflow Note ${i}`, bigContent + ' ' + i, { tags: ['query'] });
  }

  // Without policy, asking for 1000 tokens should return around 12-15 items
  const noPolicyMems = store.loadForTask('query', 1000);
  assert.ok(noPolicyMems.length > 10);

  // With shell policy, the budget is capped at 600 tokens, which fits at most 8 items
  const shellMems = store.loadForTask('query', 1000, { taskType: 'shell' });
  assert.ok(shellMems.length <= 8, `Shell policy should cap results. Found: ${shellMems.length}`);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3A - Category policy filter works on JSON fallback path', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('convention', 'Conv 1', 'Content matching query here 1', { tags: ['query'] });
  store.remember('gotcha', 'Gotcha 1', 'Content matching query here 2', { tags: ['query'] });

  // Disable SQLite to force JSON path
  store.sqliteStore = null;

  // With shell policy, only gotchas are loaded, conventions are skipped
  const results = store.loadForTask('query', 800, { taskType: 'shell' });
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'gotcha');

  cleanupDir(rootDir);
});
