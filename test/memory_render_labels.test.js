'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryObject, renderMemoryForContext } = require('../bin/memory');
const { summarizeTrace } = require('../src/memory/evidence');

test('renderMemoryForContext preserves line breaks in content', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Test Title',
    content: 'First line\nSecond line\nThird line',
    tags: ['manual']
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /First line\nSecond line\nThird line/);
  assert.ok(!rendered.includes('First line Second line Third line'), 'Line breaks should not be collapsed to spaces');
});

test('renderMemoryForContext sanitizes/collapses line breaks in title', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Title Line 1\nTitle Line 2',
    content: 'Body content',
    tags: ['manual']
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /Title Line 1 Title Line 2/);
  assert.ok(!rendered.includes('Title Line 1\nTitle Line 2'), 'Title line breaks should be collapsed');
});

test('success evidence renders [SUCCESS]', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Success task',
    content: 'Task body',
    tags: ['evidence', 'success']
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /\[SUCCESS\]/);
  assert.ok(rendered.includes('[SUCCESS] Success task'), 'Should render [SUCCESS] before the title');
});

test('partial-failure evidence renders [PARTIAL_FAILURE]', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Partial failure task',
    content: 'Task body',
    tags: ['evidence', 'partial-failure']
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /\[PARTIAL_FAILURE\]/);
  assert.ok(rendered.includes('[PARTIAL_FAILURE] Partial failure task'), 'Should render [PARTIAL_FAILURE] before the title');
});

test('validation-failed evidence renders [VALIDATION_FAILED]', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Validation failed task',
    content: 'Task body',
    tags: ['evidence', 'validation-failed']
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /\[VALIDATION_FAILED\]/);
  assert.ok(rendered.includes('[VALIDATION_FAILED] Validation failed task'), 'Should render [VALIDATION_FAILED] before the title');
});

test('failure labels take precedence over success if tags overlap', () => {
  // validation-failed and success overlap -> validation-failed wins
  const obj1 = new MemoryObject({
    type: 'context',
    title: 'Overlap 1',
    content: 'Task body',
    tags: ['evidence', 'success', 'validation-failed']
  });
  const rendered1 = renderMemoryForContext(obj1);
  assert.match(rendered1, /\[VALIDATION_FAILED\]/);
  assert.ok(!rendered1.includes('[SUCCESS]'), 'validation-failed should override success');

  // partial-failure and success overlap -> partial-failure wins
  const obj2 = new MemoryObject({
    type: 'context',
    title: 'Overlap 2',
    content: 'Task body',
    tags: ['evidence', 'success', 'partial-failure']
  });
  const rendered2 = renderMemoryForContext(obj2);
  assert.match(rendered2, /\[PARTIAL_FAILURE\]/);
  assert.ok(!rendered2.includes('[SUCCESS]'), 'partial-failure should override success');
});

test('normal non-evidence memory renders without a status label', () => {
  const obj = new MemoryObject({
    type: 'decision',
    title: 'Design Choice',
    content: 'Keep files under 500 lines',
    tags: ['convention'] // no evidence tag
  });

  const rendered = renderMemoryForContext(obj);
  assert.ok(!rendered.includes('[SUCCESS]'), 'Should not contain [SUCCESS]');
  assert.ok(!rendered.includes('[PARTIAL_FAILURE]'), 'Should not contain [PARTIAL_FAILURE]');
  assert.ok(!rendered.includes('[VALIDATION_FAILED]'), 'Should not contain [VALIDATION_FAILED]');
  assert.ok(!rendered.includes('[UNKNOWN]'), 'Should not contain [UNKNOWN]');
  assert.ok(rendered.includes('Design Choice —'), 'Should render title directly');
});

test('evidence with no known outcome renders [UNKNOWN]', () => {
  const obj = new MemoryObject({
    type: 'context',
    title: 'Generic task',
    content: 'Task body',
    tags: ['evidence'] // evidence but no success/partial-failure/validation-failed tags
  });

  const rendered = renderMemoryForContext(obj);
  assert.match(rendered, /\[UNKNOWN\]/);
  assert.ok(rendered.includes('[UNKNOWN] Generic task'), 'Should render [UNKNOWN] before the title');
});

test('evidence text uses "Successful tool calls" and "Failed tool calls"', () => {
  const trace = {
    prompt: 'test task',
    steps: [
      { type: 'tool_call', name: 'write_file', args: { path: 'a.js' }, result: 'ok' },
      { type: 'tool_call', name: 'bash', args: { command: 'npm run test' }, result: 'error: exit code 1' }
    ],
    durationMs: 1500
  };

  const summary = summarizeTrace(trace, { taskType: 'coding' });
  assert.ok(summary);
  assert.match(summary.content, /Failed tool calls:/);
  assert.match(summary.content, /Successful tool calls:/);
  assert.ok(!summary.content.includes('Failed steps:'), 'Should not use Failed steps:');
  assert.ok(!summary.content.includes('Successful steps:'), 'Should not use Successful steps:');
});
