'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReadGuard, estimateHistoryTokens, estTokens } = require('../src/session/read_guard');

const READ_TOOL = 'read_file';
const NON_READ_TOOL = 'bash';

function manyLines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`).join('\n');
}

test('content under cap is passed through untouched', () => {
  const content = 'short content';
  const out = applyReadGuard({
    toolName: READ_TOOL, content, history: [], config: {}, fixedCap: 8000,
  });
  assert.equal(out.trimmed, false);
  assert.equal(out.content, content);
});

test('non-read tool over cap gets head/tail trim with legacy hint', () => {
  const content = 'A'.repeat(20000);
  const out = applyReadGuard({
    toolName: NON_READ_TOOL,
    content,
    history: [],
    config: { context: { detected_window: 32768, max_budget_pct: 70 } },
    fixedCap: 8000,
  });
  assert.equal(out.trimmed, true);
  assert.equal(out.reason, 'fixed-cap');
  // Should preserve head + tail bytes
  assert.match(out.content, /A{500}/);
  assert.match(out.content, /\d+ chars total/);
});

test('read tool over cap with low context pressure gets head/tail with re-read hint', () => {
  // 1500 lines of "source-NNN ..." padding ≈ 30k chars — well past the 8k fixedCap.
  const content = manyLines(1500, 'source-line-with-padding-text');
  const out = applyReadGuard({
    toolName: READ_TOOL,
    content,
    history: [{ role: 'user', content: 'tiny task' }],
    config: { context: { detected_window: 200000, max_budget_pct: 70 } },
    fixedCap: 8000,
  });
  assert.equal(out.trimmed, true);
  assert.equal(out.reason, 'fixed-cap-with-hint');
  assert.match(out.content, /re-read a smaller line range/);
});

test('read tool with high context pressure gets aggressive head-only trim', () => {
  const content = manyLines(2000, 'src');
  // Simulate a history that already consumed >70% of a 32k window.
  const heavy = 'X'.repeat(32768 * 4 * 0.8); // chars/4 ≈ 80% of window
  const out = applyReadGuard({
    toolName: READ_TOOL,
    content,
    history: [{ role: 'user', content: heavy }],
    config: { context: { detected_window: 32768, max_budget_pct: 70 } },
    fixedCap: 8000,
    headLines: 30,
  });
  assert.equal(out.trimmed, true);
  assert.equal(out.reason, 'context-pressure');
  assert.match(out.content, /\[READ-GUARD\] showing first 30 lines/);
  // The head should contain the first 30 of the file, not the tail
  assert.match(out.content, /^src-1\n/);
  assert.doesNotMatch(out.content, /src-1999/);
});

test('read tool whose file alone exceeds 50% of the window also triggers aggressive trim', () => {
  // Use a small window so a moderately large file alone exceeds 50%.
  const content = 'Z'.repeat(20000); // ~5000 tokens
  const out = applyReadGuard({
    toolName: READ_TOOL,
    content,
    history: [],
    config: { context: { detected_window: 8192, max_budget_pct: 70 } },
    fixedCap: 8000,
    headLines: 30,
  });
  assert.equal(out.trimmed, true);
  assert.equal(out.reason, 'context-pressure');
});

test('estimateHistoryTokens accounts for content + tool_calls arguments', () => {
  const history = [
    { role: 'user', content: 'abcd' }, // 4 chars → 1 token
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  ];
  const total = estimateHistoryTokens(history);
  assert.ok(total >= 1);
  assert.equal(estTokens('abcd'), 1);
});

test('empty content returns trimmed=false and empty string', () => {
  const out = applyReadGuard({ toolName: READ_TOOL, content: '', history: [], config: {} });
  assert.equal(out.trimmed, false);
  assert.equal(out.content, '');
});
