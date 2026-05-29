// Slice 2E — SQLite Authority: get(), stats(), and forget()
//
// Verifies:
// 1. get(id) retrieves from SQLite and maps correctly.
// 2. get(id) falls back to JSON when SQLite is unavailable or missing the row.
// 3. get(id) ignores expired SQLite rows.
// 4. stats() aggregates from SQLite first using the existing return shape.
// 5. stats() falls back to JSON when SQLite is empty or disabled.
// 6. forget(id) deletes across sessions using metadata from SQLite.
// 7. forget(id) still deletes JSON-only memories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore, MemoryObject } = require('../bin/memory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice2e-'));
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

test('Slice 2E - get(id) retrieves from SQLite and maps correctly', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  const obj = store.remember('gotcha', 'Title', 'Content', { tags: ['test-tag'] });
  const id = obj.id;

  // Clear memory cache so it must read from SQLite
  store.objects.clear();

  const retrieved = store.get(id);
  assert.ok(retrieved);
  assert.equal(retrieved.id, id);
  assert.equal(retrieved.type, 'gotcha');
  assert.equal(retrieved.title, 'Title');
  assert.equal(retrieved.content, 'Content');
  assert.deepEqual(retrieved.tags, ['test-tag']);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2E - get(id) falls back to JSON when SQLite has no row or is null', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  const obj = store.remember('gotcha', 'Title', 'Content');
  const id = obj.id;

  // 1. Missing in SQLite
  store.sqliteStore.db.prepare('DELETE FROM memories').run();
  
  const retrieved1 = store.get(id);
  assert.ok(retrieved1);
  assert.equal(retrieved1.id, id);

  // 2. sqliteStore is null
  store.sqliteStore = null;
  const retrieved2 = store.get(id);
  assert.ok(retrieved2);
  assert.equal(retrieved2.id, id);

  cleanupDir(rootDir);
});

test('Slice 2E - get(id) ignores expired SQLite rows', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Create an item that expires in 1 millisecond
  const obj = store.remember('gotcha', 'Title', 'Content', { ttlDays: 0.00000001 });
  const id = obj.id;

  // Wait to expire
  store.sqliteStore.config.now = () => Date.now() + 1000;

  // Clear JSON cache to force SQLite check
  store.objects.clear();

  const retrieved = store.get(id);
  assert.equal(retrieved, null, 'Expired row should not be retrieved');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2E - stats() aggregates from SQLite first', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Dec 1', 'Content 1');
  store.remember('decision', 'Dec 2', 'Content 2');
  store.remember('workflow', 'Work 1', 'Content 3');

  // Clear cache to prove it uses SQLite
  store.objects.clear();

  const s = store.stats();
  assert.equal(s.total, 3);
  assert.equal(s.byType.decision, 2);
  assert.equal(s.byType.workflow, 1);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2E - stats() falls back to JSON when SQLite is empty or disabled', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Dec 1', 'Content');

  // 1. Empty SQLite (but JSON has rows)
  store.sqliteStore.db.prepare('DELETE FROM memories').run();
  let s1 = store.stats();
  assert.equal(s1.total, 1);
  assert.equal(s1.byType.decision, 1);

  // 2. Disabled SQLite
  store.sqliteStore = null;
  let s2 = store.stats();
  assert.equal(s2.total, 1);
  assert.equal(s2.byType.decision, 1);

  cleanupDir(rootDir);
});

test('Slice 2E - forget(id) deletes across sessions using SQLite metadata', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  const obj = store.remember('gotcha', 'Title', 'Content');
  const id = obj.id;

  // Confirm markdown file exists
  const mdFile = path.join(rootDir, '.smallcode/memory', `gotcha-${id}.md`);
  assert.ok(fs.existsSync(mdFile), 'Markdown sidecar must exist');

  // Simulate starting a new session (JSON cache is empty, but SQLite and markdown remain)
  store.objects.clear();

  // Deleting should query SQLite for type to unlink correct file
  const deleted = store.forget(id);
  assert.equal(deleted, true, 'Deletion must return true');
  assert.ok(!fs.existsSync(mdFile), 'Markdown sidecar must be unlinked');

  // Verify deleted from SQLite
  const row = store.sqliteStore.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  assert.ok(!row, 'SQLite row must be gone');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2E - forget(id) still deletes JSON-only memories', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Create a memory without sqliteStore
  const tempSqliteStore = store.sqliteStore;
  store.sqliteStore = null;

  const obj = store.remember('decision', 'Title', 'Content');
  const id = obj.id;

  const mdFile = path.join(rootDir, '.smallcode/memory', `decision-${id}.md`);
  assert.ok(fs.existsSync(mdFile), 'Markdown sidecar must exist');

  // Restore sqliteStore but clear SQLite DB to simulate JSON-only
  store.sqliteStore = tempSqliteStore;
  store.sqliteStore.db.prepare('DELETE FROM memories').run();

  // Deleting should delete JSON memory and unlink sidecar
  const deleted = store.forget(id);
  assert.equal(deleted, true);
  assert.ok(!fs.existsSync(mdFile), 'Markdown sidecar must be unlinked');
  assert.equal(store.get(id), null);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});
