// Slice 3C — Memory Write Policy Tests
//
// Verifies:
// 1. Auto-evidence block on disallowed task types (shell, search, explanation).
// 2. Auto-evidence accept on allowed task types (coding, editing, backend, debugging).
// 3. Auto-evidence default TTL (7 days) vs manual context default TTL (30 days) vs high-value memory default TTL (0/permanent).
// 4. Rejection of empty/blank titles/contents.
// 5. Exact text duplicate rejection returning duplicate: true.
// 6. Same category + title superseding (forgetting the old memory) for high-value categories.
// 7. Same category + title superseding (forgetting the old memory) for auto-evidence.
// 8. Direct user writes bypass taskType checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { MemoryStore } = require('../bin/memory');
const { recordEvidence } = require('../src/memory/evidence');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice3c-'));
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

test('Slice 3C - minimum fields validation', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // 1. Empty title
  const r1 = store.remember('decision', '', 'Some Content');
  assert.ok(r1.rejected);
  assert.equal(r1.reason, 'Memory title cannot be empty.');

  // 2. Empty content
  const r2 = store.remember('decision', 'Some Title', '  ');
  assert.ok(r2.rejected);
  assert.equal(r2.reason, 'Memory content cannot be empty.');

  // 3. Valid title and content
  const r3 = store.remember('decision', 'T', 'C');
  assert.ok(!r3.rejected);
  assert.equal(r3.title, 'T');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3C - auto-evidence task type validation', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Create a mock finished trace
  const trace = {
    prompt: 'make a change',
    steps: [
      { type: 'tool_call', name: 'write_file', args: { path: 'a.js' }, result: 'ok' }
    ],
    durationMs: 1000
  };

  // 1. Auto-evidence disallowed on taskType 'shell'
  const res1 = recordEvidence(store, trace, { taskType: 'shell' });
  assert.ok(!res1 || res1.rejected);

  // 2. Auto-evidence disallowed on taskType 'search'
  const res2 = recordEvidence(store, trace, { taskType: 'search' });
  assert.ok(!res2 || res2.rejected);

  // 3. Auto-evidence allowed on taskType 'coding'
  const res3 = recordEvidence(store, trace, { taskType: 'coding' });
  assert.ok(res3 && !res3.rejected);
  assert.equal(res3.title, 'make a change');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3C - default TTL assignment', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // 1. High-value memories get TTL of 0 (permanent)
  const dec = store.remember('decision', 'Dec Title', 'Dec Content');
  assert.ok(!dec.rejected);
  const decRow = store.sqliteStore.db.prepare('SELECT expires_at FROM memories WHERE id = ?').get(dec.id);
  assert.equal(decRow.expires_at, null);

  // 2. Manual context memories get default 30 days TTL
  const ctx = store.remember('context', 'Ctx Title', 'Ctx Content');
  assert.ok(!ctx.rejected);
  const ctxRow = store.sqliteStore.db.prepare('SELECT expires_at FROM memories WHERE id = ?').get(ctx.id);
  assert.ok(ctxRow.expires_at > 0);
  const diffDaysCtx = (ctxRow.expires_at - store.sqliteStore.config.now()) / (1000 * 60 * 60 * 24);
  assert.ok(diffDaysCtx > 29 && diffDaysCtx <= 30);

  // 3. Auto-evidence gets 7 days TTL
  const trace = {
    prompt: 'testing TTL',
    steps: [
      { type: 'tool_call', name: 'write_file', args: { path: 'b.js' }, result: 'ok' }
    ]
  };
  const ev = recordEvidence(store, trace, { taskType: 'coding' });
  assert.ok(ev && !ev.rejected);
  const evRow = store.sqliteStore.db.prepare('SELECT expires_at FROM memories WHERE id = ?').get(ev.id);
  assert.ok(evRow.expires_at > 0);
  const diffDaysEv = (evRow.expires_at - store.sqliteStore.config.now()) / (1000 * 60 * 60 * 24);
  assert.ok(diffDaysEv > 6 && diffDaysEv <= 7);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3C - duplicate content rejection', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  const original = store.remember('decision', 'Title A', 'Unique Content String');
  assert.ok(!original.rejected);

  // Attempt duplicate content write (different title/category, but same content)
  const dup = store.remember('gotcha', 'Title B', '  Unique Content String  ');
  assert.ok(dup.duplicate);
  assert.equal(dup.existing_id, original.id);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3C - high-value and evidence superseding by title', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // 1. High-value category same title -> supersedes (deletes old)
  const dec1 = store.remember('decision', 'My Decision', 'Content Version 1');
  assert.ok(store.get(dec1.id));

  const dec2 = store.remember('decision', 'My Decision', 'Content Version 2');
  assert.ok(!store.get(dec1.id), 'Old decision should be deleted');
  assert.ok(store.get(dec2.id), 'New decision should exist');

  // 2. Context (non-high-value, non-evidence) same title -> allowed, does NOT supersede
  const c1 = store.remember('context', 'My Context', 'Ctx 1');
  const c2 = store.remember('context', 'My Context', 'Ctx 2');
  assert.ok(store.get(c1.id));
  assert.ok(store.get(c2.id));

  // 3. Evidence (same title) -> supersedes (deletes old)
  const trace1 = {
    prompt: 'Ev Prompt',
    steps: [{ type: 'tool_call', name: 'write_file', args: { path: 'a.js' }, result: 'ok' }]
  };
  const ev1 = recordEvidence(store, trace1, { taskType: 'coding' });
  assert.ok(store.get(ev1.id));

  const trace2 = {
    prompt: 'Ev Prompt',
    steps: [{ type: 'tool_call', name: 'write_file', args: { path: 'b.js' }, result: 'ok2' }]
  };
  const ev2 = recordEvidence(store, trace2, { taskType: 'coding' });
  assert.ok(!store.get(ev1.id), 'Old evidence should be superseded');
  assert.ok(store.get(ev2.id), 'New evidence should exist');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3C - direct user writes bypass taskType validation', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Direct manual write (even if taskType is disallowed for auto-writes)
  const res = store.remember('decision', 'Manual title', 'Manual content', { taskType: 'shell' });
  assert.ok(res && !res.rejected);
  assert.equal(res.title, 'Manual title');

  store.sqliteStore.close();
  cleanupDir(rootDir);
});
