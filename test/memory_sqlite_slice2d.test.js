// Slice 2D — SQLite title/listing/schema cleanup
//
// Verifies:
// 1. Schema migration adds the `title` column if it is missing.
// 2. saveMemory() accepts, stores, and falls back for title.
// 3. remember() passes title to SQLite.
// 4. loadForTask() reads real title from SQLite, falls back to content prefix if null.
// 5. byType() lists from SQLite when available, falls back to JSON.
// 6. all() lists from SQLite when available, falls back to JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');
const { MemoryStore: SqliteMemoryStore } = require('../src/memory/memory_store');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice2d-'));
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

test('Slice 2D - Schema has title column after init()', () => {
  const dbPath = path.join(makeTempDir(), 'test.db');
  
  // Create DB without title first to test migration
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.prepare(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      keywords TEXT,
      source TEXT,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      use_count INTEGER DEFAULT 0,
      expires_at INTEGER
    )
  `).run();
  db.close();

  // Run init which should execute the ALTER TABLE migration
  const store = new SqliteMemoryStore({ dbPath });
  store.init();

  const cols = store.db.pragma('table_info(memories)').map(c => c.name);
  assert.ok(cols.includes('title'), 'memories table must contain title column');

  store.close();
  cleanupDir(path.dirname(dbPath));
});

test('Slice 2D - saveMemory() stores title and falls back when missing', () => {
  const dbPath = ':memory:';
  const store = new SqliteMemoryStore({ dbPath });
  store.init();

  // 1. With title
  const id1 = store.saveMemory({
    category: 'decision',
    title: 'Custom Title',
    text: 'Body content here',
  });
  const list1 = store.list();
  const row1 = list1.find(r => r.id === id1);
  assert.equal(row1.title, 'Custom Title');

  // 2. Without title (blank/undefined)
  const id2 = store.saveMemory({
    category: 'decision',
    text: 'Line One\nLine Two',
  });
  const list2 = store.list();
  const row2 = list2.find(r => r.id === id2);
  assert.equal(row2.title, 'Line One');

  store.close();
});

test('Slice 2D - remember() bridge passes title to SQLite', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Keep it simple', 'Simple is better than complex.', {
    tags: ['design'],
  });

  // Query directly from SQLite
  const list = store.sqliteStore.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Keep it simple');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2D - loadForTask() uses real title and falls back when null', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // 1. Store memory with real title
  store.remember('decision', 'Specific Title', 'Content about testing loadForTask', {
    tags: ['loadfortask'],
  });

  const results = store.loadForTask('testing loadForTask');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Specific Title');

  // 2. Simulate old legacy row where title is null in database
  store.sqliteStore.db.prepare("UPDATE memories SET title = NULL WHERE category = 'decision'").run();

  const resultsFallback = store.loadForTask('testing loadForTask');
  assert.equal(resultsFallback.length, 1);
  // Falls back to first line of text
  assert.equal(resultsFallback[0].title, 'Content about testing loadForTask');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2D - byType() and all() query SQLite first when available', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Decision 1', 'Content 1');
  store.remember('convention', 'Convention 1', 'Content 2');

  // Spy on sqliteStore.list
  let listCalledCount = 0;
  const origList = store.sqliteStore.list.bind(store.sqliteStore);
  store.sqliteStore.list = (opts) => {
    listCalledCount++;
    return origList(opts);
  };

  // test byType
  const decisions = store.byType('decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].title, 'Decision 1');
  assert.equal(listCalledCount, 1);

  // test all
  const allMems = store.all();
  assert.equal(allMems.length, 2);
  assert.equal(listCalledCount, 2);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 2D - byType() and all() fall back to JSON when SQLite is unavailable', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  store.remember('decision', 'Decision 1', 'Content 1');

  // Disable SQLite
  store.sqliteStore = null;

  const decisions = store.byType('decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].title, 'Decision 1');

  const allMems = store.all();
  assert.equal(allMems.length, 1);
  assert.equal(allMems[0].title, 'Decision 1');

  cleanupDir(rootDir);
});
