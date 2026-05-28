'use strict';

// Slice 2C — loadForTask() runtime read path upgrade
//
// Verifies that loadForTask() prefers the SQLite recall() path when SQLite is
// available and has results, and falls back to the legacy JSON keyword loop
// when SQLite is unavailable or returns nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice2c-'));
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
// Slice 2C — SQLite path is preferred when available
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - loadForTask uses SQLite recall when sqliteStore is available', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Write via remember() — dual-writes to JSON + SQLite
  store.remember('gotcha', 'Avoid circular imports', 'Do not import modules recursively.', {
    tags: ['imports', 'circular'],
  });

  // Confirm sqliteStore is ready
  assert.ok(store.sqliteStore, 'sqliteStore must be initialized');
  assert.ok(store.sqliteStore.db, 'sqliteStore.db must be open');

  // Track whether SQLite recall() was called
  let sqliteRecallCalled = false;
  const origRecall = store.sqliteStore.recall.bind(store.sqliteStore);
  store.sqliteStore.recall = (query, opts) => {
    sqliteRecallCalled = true;
    return origRecall(query, opts);
  };

  const results = store.loadForTask('fix circular import problem');
  assert.equal(sqliteRecallCalled, true, 'SQLite recall() must be called');
  assert.ok(results.length > 0, 'Must return results');

  // Verify result shape is MemoryObject-compatible
  const first = results[0];
  assert.ok(first.id, 'result must have id');
  assert.ok(first.type, 'result must have type');
  assert.ok(first.content, 'result must have content');
  assert.ok(Array.isArray(first.tags), 'result must have tags array');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2C — category is mapped correctly (SQLite 'category' → 'type')
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - SQLite category is exposed as type field', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Use patch for edits', 'Always use the patch tool, not full rewrites.', {
    tags: ['patch', 'edit'],
  });

  const results = store.loadForTask('how to edit files with patch');
  assert.ok(results.length > 0);
  // 'decision' stored in SQLite as category='decision'; loadForTask must map → type
  assert.equal(results[0].type, 'decision');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2C — fallback to legacy JSON loop when SQLite has no results
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - falls back to JSON when SQLite returns empty', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Remember something so JSON store has data
  store.remember('convention', 'Use 2 spaces', 'Always use 2-space indentation.', {
    tags: ['style'],
  });

  // Force SQLite recall to return empty so fallback fires
  let legacyHit = false;
  store.sqliteStore.recall = () => [];

  // Spy on the legacy path via objects Map size
  const origSize = store.objects.size;
  assert.equal(origSize, 1, 'JSON store must have 1 object');

  // Query that matches the JSON store
  const results = store.loadForTask('indentation style spaces');
  // The legacy path should have matched 'Use 2 spaces'
  assert.ok(results.length > 0, 'Legacy fallback must return results');
  assert.equal(results[0].type, 'convention');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2C — falls back to JSON loop when sqliteStore is null
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - falls back to JSON loop when sqliteStore is null', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('workflow', 'Run tests first', 'Always run node --test before committing.', {
    tags: ['testing'],
  });

  // Simulate SQLite not available
  store.sqliteStore = null;

  const results = store.loadForTask('how to run tests');
  assert.ok(results.length > 0, 'Must still return results from JSON');
  assert.equal(results[0].type, 'workflow');

  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2C — fault containment: SQLite recall throwing does not crash
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - SQLite recall() crash falls back gracefully', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('gotcha', 'Watch for race conditions', 'Async handlers can overlap.', {
    tags: ['async', 'concurrency'],
  });

  // Make SQLite recall throw
  store.sqliteStore.recall = () => {
    throw new Error('Simulated SQLite crash');
  };

  // Must not throw — must fall back to JSON
  let results;
  assert.doesNotThrow(() => {
    results = store.loadForTask('async race condition problem');
  });

  assert.ok(results.length > 0, 'Legacy fallback must still return results');
  assert.equal(results[0].type, 'gotcha');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2C — maxTokens param is forwarded to SQLite limit
// ─────────────────────────────────────────────────────────────────────────────

test('Slice 2C - maxTokens converts to a SQLite recall limit', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Write 4 memories
  for (let i = 1; i <= 4; i++) {
    store.remember('context', `Note ${i}`, `Content about testing and recall item ${i}.`, {
      tags: ['testing'],
    });
  }

  let capturedOpts;
  const orig = store.sqliteStore.recall.bind(store.sqliteStore);
  store.sqliteStore.recall = (q, opts) => {
    capturedOpts = opts;
    return orig(q, opts);
  };

  // maxTokens=100 → limit = ceil(100/50) = 2
  store.loadForTask('testing recall', 100);
  assert.ok(capturedOpts, 'recall must receive opts');
  assert.equal(capturedOpts.limit, 2, 'limit should be ceil(maxTokens/50)');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});
