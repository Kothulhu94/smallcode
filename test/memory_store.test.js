'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MemoryStore, CATEGORIES } = require('../src/memory/memory_store');

const TEST_DB = path.join(process.cwd(), '.smallcode', 'memory', 'test_memory.db');

function cleanup() {
  try {
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema & Initialization Tests
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - schema creation', () => {
  cleanup();
  const store = new MemoryStore({ dbPath: TEST_DB });
  store.init();

  assert.ok(fs.existsSync(TEST_DB));
  assert.equal(store.useFts, true, 'FTS5 should be supported by default better-sqlite3 in this environment');

  store.close();
  cleanup();
});

test('MemoryStore - save and list memories', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();

  const id1 = store.saveMemory({
    category: CATEGORIES.DECISION,
    text: 'We use patch edits rather than rewriting files',
    keywords: ['patch', 'edit', 'rewrite'],
    source: 'plan.md',
  });

  const id2 = store.saveMemory({
    category: CATEGORIES.CONVENTION,
    text: 'Maximum file length is 500 lines',
    keywords: 'max, lines, 500',
  });

  assert.ok(id1);
  assert.ok(id2);

  // List all memories
  const list = store.list();
  assert.equal(list.length, 2);

  // Check fields
  const mem1 = list.find(m => m.id === id1);
  assert.equal(mem1.category, CATEGORIES.DECISION);
  assert.equal(mem1.text, 'We use patch edits rather than rewriting files');
  assert.equal(mem1.keywords, 'patch, edit, rewrite');
  assert.equal(mem1.source, 'plan.md');
  assert.equal(mem1.use_count, 0);

  store.close();
});

test('MemoryStore - invalid category throws', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();

  assert.throws(() => {
    store.saveMemory({
      category: 'invalid_category',
      text: 'Some memory',
    });
  }, /Invalid category/);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Category Filtering
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - category filtering in list', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();

  store.saveMemory({ category: CATEGORIES.DECISION, text: 'Decision memory' });
  store.saveMemory({ category: CATEGORIES.CONVENTION, text: 'Convention memory' });

  const decisions = store.list({ category: CATEGORIES.DECISION });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].text, 'Decision memory');

  const conventions = store.list({ category: CATEGORIES.CONVENTION });
  assert.equal(conventions.length, 1);
  assert.equal(conventions[0].text, 'Convention memory');

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Recall & Ranking Tests
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - recall by keyword/text and ranking', () => {
  let fakeTime = 1000;
  const store = new MemoryStore({
    dbPath: ':memory:',
    now: () => fakeTime,
  });
  store.init();

  // Save multiple memories
  store.saveMemory({
    category: CATEGORIES.GOTCHA,
    text: 'The auth module has circular imports',
    keywords: ['auth', 'circular', 'imports'],
  });

  store.saveMemory({
    category: CATEGORIES.WORKFLOW,
    text: 'Run git diff before commit',
    keywords: ['git', 'diff', 'commit'],
  });

  // Query matching 'auth'
  let results = store.recall('how to fix auth circular error?');
  assert.equal(results.length, 1);
  assert.equal(results[0].category, CATEGORIES.GOTCHA);
  assert.match(results[0].text, /circular imports/);

  // Query matching 'git'
  results = store.recall('check git status');
  assert.equal(results.length, 1);
  assert.equal(results[0].category, CATEGORIES.WORKFLOW);

  store.close();
});

test('MemoryStore - recall updates use_count and last_used', () => {
  let fakeTime = 1000;
  const store = new MemoryStore({
    dbPath: ':memory:',
    now: () => fakeTime,
  });
  store.init();

  const id = store.saveMemory({
    category: CATEGORIES.DECISION,
    text: 'Use patch edits',
    keywords: 'patch',
  });

  // Access stats before recall
  let list = store.list();
  assert.equal(list[0].use_count, 0);
  assert.equal(list[0].last_used, 1000);

  // Time shifts forward
  fakeTime = 5000;

  // Recall memory
  const results = store.recall('patch edits');
  assert.equal(results.length, 1);
  assert.equal(results[0].use_count, 1);
  assert.equal(results[0].last_used, 5000);

  // Verify database state is updated
  list = store.list();
  assert.equal(list[0].use_count, 1);
  assert.equal(list[0].last_used, 5000);

  store.close();
});

test('MemoryStore - empty query handling', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();

  store.saveMemory({ category: CATEGORIES.DECISION, text: 'Use patch edits' });

  // Safe checks against empty queries
  assert.deepEqual(store.recall(''), []);
  assert.deepEqual(store.recall('   '), []);
  assert.deepEqual(store.recall(null), []);
  assert.deepEqual(store.recall(undefined), []);
  // Stopword-only query
  assert.deepEqual(store.recall('the with of'), []);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete Memory
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - deleteMemory', () => {
  const store = new MemoryStore({ dbPath: ':memory:' });
  store.init();

  const id = store.saveMemory({
    category: CATEGORIES.DECISION,
    text: 'Use patch edits',
    keywords: 'patch',
  });

  assert.equal(store.list().length, 1);
  assert.equal(store.recall('patch').length, 1);

  store.deleteMemory(id);

  assert.equal(store.list().length, 0);
  assert.equal(store.recall('patch').length, 0);

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Expiration Tests
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - expireOld removes expired memories', () => {
  let fakeTime = 1000;
  const store = new MemoryStore({
    dbPath: ':memory:',
    now: () => fakeTime,
  });
  store.init();

  // Save non-expiring memory (ttlDays = 0)
  store.saveMemory({
    category: CATEGORIES.DECISION,
    text: 'Persistent memory',
    ttlDays: 0,
  });

  // Save expiring memory (ttlDays = 1)
  store.saveMemory({
    category: CATEGORIES.GOTCHA,
    text: 'Temporary session memory',
    keywords: 'temporary',
    ttlDays: 1,
  });

  assert.equal(store.list().length, 2);

  // Time shift forward 2 days (expired)
  fakeTime = 1000 + (2 * 24 * 60 * 60 * 1000);

  // Check that listing/recalling does not return expired items, even before expireOld is called
  let list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'Persistent memory');

  let recall = store.recall('temporary');
  assert.equal(recall.length, 0);

  // Trigger cleanup
  const removed = store.expireOld();
  assert.equal(removed, 1);

  // DB contains only 1 item now
  store.useFts = false; // Bypass FTS check to query raw SQL
  const rawList = store.db.prepare('SELECT * FROM memories').all();
  assert.equal(rawList.length, 1);
  assert.equal(rawList[0].text, 'Persistent memory');

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback LIKE Search
// ─────────────────────────────────────────────────────────────────────────────

test('MemoryStore - fallback LIKE search behaves identical when FTS5 is disabled', () => {
  let fakeTime = 1000;
  const store = new MemoryStore({
    dbPath: ':memory:',
    now: () => fakeTime,
  });
  store.init();

  // Force disable FTS5
  store.useFts = false;

  store.saveMemory({
    category: CATEGORIES.GOTCHA,
    text: 'Circular imports cause test failures',
    keywords: 'circular, tests',
  });

  store.saveMemory({
    category: CATEGORIES.DECISION,
    text: 'Avoid native binary compiles',
    keywords: 'compile, native',
  });

  // Query matching 'circular'
  let results = store.recall('how to fix circular imports?');
  assert.equal(results.length, 1);
  assert.equal(results[0].category, CATEGORIES.GOTCHA);
  assert.match(results[0].text, /Circular imports/);
  assert.equal(results[0].use_count, 1);

  // Query matching 'native'
  results = store.recall('avoid native compiles');
  assert.equal(results.length, 1);
  assert.equal(results[0].category, CATEGORIES.DECISION);

  store.close();
});
