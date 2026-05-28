const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('crypto');

const { MemoryStore, MemoryObject } = require('../bin/memory');

function setupStore() {
  const rootDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sc-mem-'));
  const store = new MemoryStore(rootDir);
  return { store, rootDir };
}

test('MemoryStore.saveMemory accepts caller-provided id', () => {
  const { store } = setupStore();
  const id = 'my-custom-id-123';
  const obj = store.remember('decision', 'Title', 'Content', { id });
  assert.equal(obj.id, id);
  assert.equal(store.get(id), obj);
});

test('MemoryStore forget deletes from SQLite as well', () => {
  const { store } = setupStore();
  const obj = store.remember('decision', 'Title', 'Content');
  const id = obj.id;

  // Fake SQLite
  let sqliteDeleted = false;
  store.sqliteStore = {
    forget: (fid) => {
      if (fid === id) sqliteDeleted = true;
      return true;
    }
  };

  const res = store.forget(id);
  assert.equal(res, true);
  assert.equal(store.get(id), null);
  assert.equal(sqliteDeleted, true);
});

test('SQLite delete failure is contained and does not break legacy forget', () => {
  const { store } = setupStore();
  const obj = store.remember('decision', 'Title', 'Content');
  const id = obj.id;

  store.sqliteStore = {
    forget: (fid) => {
      throw new Error("SQLite crash!");
    }
  };

  const res = store.forget(id);
  assert.equal(res, true);
  assert.equal(store.get(id), null);
});
