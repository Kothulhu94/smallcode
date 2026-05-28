const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../src/memory/memory_store.js');

test('MemoryStore basic save and forget', () => {
  const store = new MemoryStore();
  const mem = store.saveMemory({ type: 'decision', title: 'A', content: 'B', tags: [] });
  assert.ok(mem.id);

  const forgotten = store.forget(mem.id);
  assert.equal(forgotten, true);
});
