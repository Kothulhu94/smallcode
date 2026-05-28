'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { EventJournal, openJournal, EVENT_TYPES } = require('../src/session/event_journal');

// All tests use a unique session dir under .smallcode/sessions/ and clean up
// after themselves. The prefix ensures we never collide with real sessions.
const TEST_ROOT = process.cwd();
const TEST_SESSION = '_test_event_journal_' + Date.now();

function cleanup() {
  const dir = path.join(TEST_ROOT, '.smallcode', 'sessions', TEST_SESSION);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Construction ──────────────────────────────────────────────────────────

test('openJournal creates journal dir and returns an EventJournal', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);
  assert.ok(j instanceof EventJournal);
  assert.ok(fs.existsSync(path.dirname(j.filepath())));
  assert.ok(j.filepath().endsWith('events.jsonl'));
  cleanup();
});

test('constructor rejects empty sessionId', () => {
  assert.throws(() => new EventJournal(''), /non-empty sessionId/);
  assert.throws(() => new EventJournal(null), /non-empty sessionId/);
});

// ─── Append + ReadAll ──────────────────────────────────────────────────────

test('append writes valid JSONL and readAll returns all events', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  const r1 = j.append(EVENT_TYPES.FILE_READ, { path: 'a.js', summary: '10 lines' });
  const r2 = j.append(EVENT_TYPES.DECISION, { content: 'Use HS256' }, ['auth']);
  const r3 = j.append(EVENT_TYPES.TOOL_RESULT, { tool: 'patch', success: true });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);

  // Verify raw file is valid JSONL
  const raw = fs.readFileSync(j.filepath(), 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), 'each line must be valid JSON');
  }

  // readAll returns all events with correct structure
  const { events, skipped } = j.readAll();
  assert.equal(events.length, 3);
  assert.equal(skipped, 0);

  // First event has expected shape
  assert.equal(events[0].type, 'file_read');
  assert.equal(events[0].sid, TEST_SESSION);
  assert.ok(typeof events[0].t === 'number');
  assert.equal(events[0].data.path, 'a.js');

  // Second event has tags
  assert.deepEqual(events[1].tags, ['auth']);

  cleanup();
});

// ─── Event count ───────────────────────────────────────────────────────────

test('count returns number of events', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  assert.equal(j.count(), 0);
  j.append('a', {});
  j.append('b', {});
  assert.equal(j.count(), 2);

  cleanup();
});

// ─── exists ────────────────────────────────────────────────────────────────

test('exists returns false before first write, true after', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  assert.equal(j.exists(), false);
  j.append('ping', {});
  assert.equal(j.exists(), true);

  cleanup();
});

// ─── readRecent ────────────────────────────────────────────────────────────

test('readRecent(limit) returns only the newest events', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  for (let i = 0; i < 10; i++) {
    j.append('tick', { i });
  }

  const { events } = j.readRecent(3);
  assert.equal(events.length, 3);
  // Should be the last 3 (i=7,8,9)
  assert.equal(events[0].data.i, 7);
  assert.equal(events[1].data.i, 8);
  assert.equal(events[2].data.i, 9);

  cleanup();
});

test('readRecent with limit larger than total returns all', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);
  j.append('a', {});
  j.append('b', {});

  const { events } = j.readRecent(100);
  assert.equal(events.length, 2);

  cleanup();
});

// ─── readByType ────────────────────────────────────────────────────────────

test('readByType filters by single type', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  j.append(EVENT_TYPES.FILE_READ, { path: 'a.js' });
  j.append(EVENT_TYPES.DECISION, { content: 'choice A' });
  j.append(EVENT_TYPES.FILE_READ, { path: 'b.js' });
  j.append(EVENT_TYPES.ERROR, { message: 'oops' });

  const { events } = j.readByType(EVENT_TYPES.FILE_READ);
  assert.equal(events.length, 2);
  assert.equal(events[0].data.path, 'a.js');
  assert.equal(events[1].data.path, 'b.js');

  cleanup();
});

test('readByType filters by multiple types', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  j.append(EVENT_TYPES.FILE_READ, { path: 'a.js' });
  j.append(EVENT_TYPES.DECISION, { content: 'choice A' });
  j.append(EVENT_TYPES.ERROR, { message: 'oops' });

  const { events } = j.readByType([EVENT_TYPES.DECISION, EVENT_TYPES.ERROR]);
  assert.equal(events.length, 2);

  cleanup();
});

// ─── buildRecoverySummary ──────────────────────────────────────────────────

test('buildRecoverySummary includes useful recovery information', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  j.append(EVENT_TYPES.FILE_READ, { path: 'src/auth.js', summary: '340 lines' });
  j.append(EVENT_TYPES.FILE_WRITE, { path: 'src/auth.js', summary: 'Added refresh()' });
  j.append(EVENT_TYPES.DECISION, { content: 'Use HS256' });
  j.append(EVENT_TYPES.PLAN_STEP, { step: 2, total: 5, status: 'done' });
  j.append(EVENT_TYPES.TOOL_RESULT, { tool: 'bash', summary: 'Tests pass 8/8', success: true });
  j.append(EVENT_TYPES.TOOL_RESULT, { tool: 'patch', summary: 'Applied 1 patch', success: true });

  const summary = j.buildRecoverySummary();

  // Structured fields
  assert.equal(Object.keys(summary.filesRead).length, 1);
  assert.equal(summary.filesRead['src/auth.js'], '340 lines');
  assert.equal(Object.keys(summary.filesWritten).length, 1);
  assert.equal(summary.filesWritten['src/auth.js'], 'Added refresh()');
  assert.deepEqual(summary.decisions, ['Use HS256']);
  assert.equal(summary.planState.step, 2);
  assert.equal(summary.planState.total, 5);
  assert.equal(summary.eventCount, 6);

  // Text block is a string containing key info
  assert.ok(typeof summary.text === 'string');
  assert.match(summary.text, /SESSION RECOVERY/);
  assert.match(summary.text, /src\/auth\.js/);
  assert.match(summary.text, /Use HS256/);
  assert.match(summary.text, /step 2\/5/);
  assert.match(summary.text, /Tests pass 8\/8/);

  cleanup();
});

test('buildRecoverySummary on empty journal returns safe defaults', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  const summary = j.buildRecoverySummary();
  assert.equal(summary.eventCount, 0);
  assert.deepEqual(summary.filesRead, {});
  assert.deepEqual(summary.filesWritten, {});
  assert.deepEqual(summary.decisions, []);
  assert.equal(summary.planState, null);
  assert.ok(typeof summary.text === 'string');

  cleanup();
});

// ─── Resilience: missing/empty journal ─────────────────────────────────────

test('readAll on missing journal returns empty without crashing', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);
  // Don't append anything — file doesn't exist yet

  const { events, skipped } = j.readAll();
  assert.equal(events.length, 0);
  assert.equal(skipped, 0);
});

test('readAll on empty file returns empty without crashing', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);
  // Create an empty file
  fs.writeFileSync(j.filepath(), '');

  const { events, skipped } = j.readAll();
  assert.equal(events.length, 0);
  assert.equal(skipped, 0);

  cleanup();
});

// ─── Resilience: malformed JSONL lines ─────────────────────────────────────

test('malformed JSONL lines are skipped without crashing', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  // Write a mix of valid and invalid lines directly
  const content = [
    JSON.stringify({ t: 1, sid: 'x', type: 'a', data: {} }),
    'NOT VALID JSON {{{',
    JSON.stringify({ t: 2, sid: 'x', type: 'b', data: {} }),
    '',
    '{ broken',
    JSON.stringify({ t: 3, sid: 'x', type: 'c', data: {} }),
  ].join('\n');
  fs.writeFileSync(j.filepath(), content);

  const { events, skipped } = j.readAll();
  assert.equal(events.length, 3, 'should parse 3 valid events');
  assert.equal(skipped, 2, 'should skip 2 malformed lines');

  // Events are in order
  assert.equal(events[0].type, 'a');
  assert.equal(events[1].type, 'b');
  assert.equal(events[2].type, 'c');

  cleanup();
});

// ─── Payload truncation ───────────────────────────────────────────────────

test('oversized payload is truncated without crashing', () => {
  cleanup();
  const j = openJournal(TEST_SESSION, TEST_ROOT);

  const bigPayload = { content: 'X'.repeat(20000) };
  const result = j.append('big', bigPayload);
  assert.equal(result.ok, true);

  const { events } = j.readAll();
  assert.equal(events.length, 1);
  // The stored data should be smaller than the original
  const storedSize = JSON.stringify(events[0].data).length;
  assert.ok(storedSize < 20000, `stored payload should be truncated, got ${storedSize} chars`);

  cleanup();
});

// ─── Final cleanup safety net ──────────────────────────────────────────────

test('cleanup test session directory', () => {
  cleanup();
  const dir = path.join(TEST_ROOT, '.smallcode', 'sessions', TEST_SESSION);
  assert.equal(fs.existsSync(dir), false, 'test session dir should be removed');
});
