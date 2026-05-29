// Slice 3B — Memory Source Labels and Prompt Formatting
//
// Verifies:
// 1. renderMemoryForContext() without source
// 2. renderMemoryForContext() with { file, line } source
// 3. renderMemoryForContext() with plain string source
// 4. renderMemoryForContext() with JSON-stringified source
// 5. formatForContext() uses the new compact format
// 6. model_client.js buildSystemPrompt format integration

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { renderMemoryForContext, MemoryStore } = require('../bin/memory');
const { buildSystemPrompt } = require('../bin/model_client');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-slice3b-'));
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

test('Slice 3B - renderMemoryForContext() formatting rules', () => {
  // 1. Without source
  const m1 = {
    id: '12345678',
    type: 'gotcha',
    title: 'Avoid loops',
    content: 'Do not write infinite loops.'
  };
  const r1 = renderMemoryForContext(m1);
  assert.equal(r1, '[gotcha:12345678] Avoid loops — Do not write infinite loops.\n');

  // 2. With structured source object
  const m2 = {
    id: 'abcdef99',
    type: 'decision',
    title: 'Use tsc',
    content: 'Use typescript compiler.',
    source: { file: 'src/main.ts', line: 45 }
  };
  const r2 = renderMemoryForContext(m2);
  assert.equal(r2, '[decision:abcdef99 source=src/main.ts:45] Use tsc — Use typescript compiler.\n');

  // 3. With plain string source
  const m3 = {
    id: 'xyz777',
    type: 'convention',
    title: 'Tabs',
    content: 'Use spaces, not tabs.',
    source: 'doc/style.md'
  };
  const r3 = renderMemoryForContext(m3);
  assert.equal(r3, '[convention:xyz777 source=doc/style.md] Tabs — Use spaces, not tabs.\n');

  // 4. With JSON-stringified source
  const m4 = {
    id: 'uuid123456',
    type: 'workflow',
    title: 'Deploy',
    content: 'Run npm deploy.',
    source: JSON.stringify({ file: 'deploy.sh', line: 12 })
  };
  const r4 = renderMemoryForContext(m4);
  assert.equal(r4, '[workflow:uuid1234 source=deploy.sh:12] Deploy — Run npm deploy.\n'); // note ID is sliced to 8 chars

  // 5. Sanitize newlines in title and content
  const m5 = {
    id: '123',
    type: 'context',
    title: 'Line1\nLine2',
    content: 'Content1\r\nContent2',
  };
  const r5 = renderMemoryForContext(m5);
  assert.equal(r5, '[context:123] Line1 Line2 — Content1 Content2\n');
});

test('Slice 3B - formatForContext() matches compact format', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  const objects = [
    { id: '1', type: 'decision', title: 'T1', content: 'C1' },
    { id: '2', type: 'gotcha', title: 'T2', content: 'C2', source: 'a.js' }
  ];
  const formatted = store.formatForContext(objects, 800);
  const expected = '<memory>\n' +
    '[decision:1] T1 — C1\n' +
    '[gotcha:2 source=a.js] T2 — C2\n' +
    '</memory>';
  assert.equal(formatted, expected);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});

test('Slice 3B - model_client.js buildSystemPrompt format integration', () => {
  const rootDir = makeTempDir();
  const store = new MemoryStore(rootDir);
  store.init();

  // Remember a decision
  store.remember('decision', 'Decision Title', 'Decision Content', { source: 'doc.md' });

  // Call buildSystemPrompt from model_client
  const ctx = {
    config: { model: { name: 'gemma-4' } },
    memoryStore: store,
    conversationHistory: [{ role: 'user', content: 'what is the decision' }],
    currentTaskType: 'coding'
  };

  const formattedContext = buildSystemPrompt(ctx);
  assert.ok(formattedContext);
  assert.ok(formattedContext.includes('Relevant project memory:\n'), `Context: ${formattedContext}`);
  // Match expected formatting
  const expectedEntry = `[decision:${store.all()[0].id} source=doc.md] Decision Title — Decision Content`;
  assert.ok(formattedContext.includes(expectedEntry), `Context: ${formattedContext}\nExpected: ${expectedEntry}`);

  store.sqliteStore.close();
  cleanupDir(rootDir);
});
