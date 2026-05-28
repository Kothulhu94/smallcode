'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MemoryStore } = require('../bin/memory');

const TEMP_BASE = path.join(__dirname, 'temp_memory_slice2a');

function getTempDir(testName) {
  const dir = path.join(TEMP_BASE, testName.replace(/[^a-zA-Z0-9]/g, '_'));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          cleanupDir(full);
        } else {
          fs.unlinkSync(full);
        }
      }
      fs.rmdirSync(dir);
    }
  } catch {}
}

test.after(() => {
  cleanupDir(TEMP_BASE);
});

test('MemoryStore Slice 2A - initialization', () => {
  const dir = getTempDir('initialization');
  const store = new MemoryStore(dir);
  assert.ok(store);
  assert.ok(store.sqliteStore);

  store.init();

  const indexJson = path.join(dir, '.smallcode', 'memory', 'index.json');
  const memoryDb = path.join(dir, '.smallcode', 'memory', 'memory.db');

  assert.ok(fs.existsSync(indexJson), 'JSON index file should be created');
  assert.ok(fs.existsSync(memoryDb), 'SQLite DB file should be created');

  store.sqliteStore.close();
  cleanupDir(dir);
});

test('MemoryStore Slice 2A - dual-write remember() (positional)', () => {
  const dir = getTempDir('remember_positional');
  const store = new MemoryStore(dir);
  store.init();

  // Remember with positional arguments
  const obj = store.remember(
    'gotcha',
    'Avoid circular imports',
    'Do not import modules recursively.',
    { tags: ['imports', 'recursion'], source: 'app.js' }
  );

  assert.ok(obj);
  assert.equal(obj.type, 'gotcha');
  assert.equal(obj.title, 'Avoid circular imports');

  // Verify legacy save occurred
  assert.equal(store.objects.size, 1);
  const mdFile = path.join(dir, '.smallcode', 'memory', `gotcha-${obj.id}.md`);
  assert.ok(fs.existsSync(mdFile), 'Markdown file should be created');

  // Verify SQLite write occurred
  const sqliteList = store.sqliteStore.list();
  assert.equal(sqliteList.length, 1);
  assert.equal(sqliteList[0].category, 'gotcha');
  assert.equal(sqliteList[0].text, 'Do not import modules recursively.');
  assert.equal(sqliteList[0].keywords, 'imports, recursion');
  assert.equal(sqliteList[0].source, 'app.js');

  store.sqliteStore.close();
  cleanupDir(dir);
});

test('MemoryStore Slice 2A - dual-write remember() (single object / evidence signature)', () => {
  const dir = getTempDir('remember_object');
  const store = new MemoryStore(dir);
  store.init();

  // Remember with object argument (evidence summarizer signature)
  const summary = {
    type: 'context',
    title: 'Self-check task pass',
    content: 'All tests passed in 5.4s.',
    tags: ['evidence', 'success'],
    source: 'test_runner.js'
  };

  const obj = store.remember(summary);
  assert.ok(obj);
  assert.equal(obj.type, 'context');
  assert.equal(obj.title, 'Self-check task pass');
  assert.equal(obj.content, 'All tests passed in 5.4s.');

  // Verify type field is not nested as an object (resolving the type object bug)
  assert.equal(typeof obj.type, 'string');

  // Verify SQLite write occurred
  const sqliteList = store.sqliteStore.list();
  assert.equal(sqliteList.length, 1);
  assert.equal(sqliteList[0].category, 'context');
  assert.equal(sqliteList[0].text, 'All tests passed in 5.4s.');

  store.sqliteStore.close();
  cleanupDir(dir);
});

test('MemoryStore Slice 2A - category normalization', () => {
  const dir = getTempDir('category_normalization');
  const store = new MemoryStore(dir);
  store.init();

  // 'source' is not a valid category in SQLite, but is valid in legacy memory.js
  const obj = store.remember(
    'source',
    'Original specifications',
    'Spec contents',
    { tags: ['spec'] }
  );

  assert.equal(obj.type, 'source');

  // Verify legacy contains 'source'
  assert.equal(store.objects.get(obj.id).type, 'source');

  // Verify SQLite maps to 'context'
  const sqliteList = store.sqliteStore.list();
  assert.equal(sqliteList.length, 1);
  assert.equal(sqliteList[0].category, 'context');

  store.sqliteStore.close();
  cleanupDir(dir);
});

test('MemoryStore Slice 2A - fault containment', () => {
  const dir = getTempDir('fault_containment');
  const store = new MemoryStore(dir);
  store.init();

  // Mock SQLite saveMemory to fail/throw
  if (store.sqliteStore) {
    store.sqliteStore.saveMemory = () => {
      throw new Error('Database write error simulation');
    };
  }

  // Ensure writing does not crash legacy flow
  let obj;
  assert.doesNotThrow(() => {
    obj = store.remember(
      'decision',
      'Use spaces',
      'Use 2 spaces spacing.',
      { tags: ['style'] }
    );
  });

  assert.ok(obj);
  assert.equal(store.objects.size, 1);
  assert.ok(fs.existsSync(path.join(dir, '.smallcode', 'memory', 'index.json')));

  if (store.sqliteStore) {
    store.sqliteStore.close();
  }
  cleanupDir(dir);
});
