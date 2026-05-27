'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { QualityMonitor, MAX_CORRECTIONS, _editDistance } = require('../src/governor/quality_monitor');

test('empty response (no text + no tool calls) fires empty_response', () => {
  const qm = new QualityMonitor();
  const sig = qm.inspect({ message: { content: '   ', tool_calls: [] }, knownTools: ['read_file'] });
  assert.ok(sig);
  assert.equal(sig.kind, 'empty_response');
  assert.match(sig.injection, /\[QUALITY-MONITOR\]/);
});

test('empty tool name fires empty_tool_name', () => {
  const qm = new QualityMonitor();
  const sig = qm.inspect({
    message: { content: '', tool_calls: [{ function: { name: '', arguments: '{}' } }] },
    knownTools: ['read_file', 'patch'],
  });
  assert.ok(sig);
  assert.equal(sig.kind, 'empty_tool_name');
});

test('hallucinated tool name fires hallucinated_tool with closest matches', () => {
  const qm = new QualityMonitor();
  const sig = qm.inspect({
    message: { content: '', tool_calls: [{ function: { name: 'red_file', arguments: '{}' } }] },
    knownTools: ['read_file', 'write_file', 'patch'],
  });
  assert.ok(sig);
  assert.equal(sig.kind, 'hallucinated_tool');
  // Closest match should include read_file (edit distance 1 from "red_file")
  assert.match(sig.injection, /read_file/);
});

test('healthy turn returns null and resets consecutive counter', () => {
  const qm = new QualityMonitor();
  const ok1 = qm.inspect({
    message: { content: 'hi', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    knownTools: ['read_file'],
  });
  assert.equal(ok1, null);
});

test('cross-turn repeated identical tool call fires repeat_call', () => {
  const qm = new QualityMonitor();
  // First turn — primes the lastCallSignature, no signal.
  const t1 = qm.inspect({
    message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    knownTools: ['read_file'],
  });
  assert.equal(t1, null);
  // Second turn — exact same call.
  const t2 = qm.inspect({
    message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    knownTools: ['read_file'],
  });
  assert.ok(t2);
  assert.equal(t2.kind, 'repeat_call');
});

test('multi-call turn does not trip repeat detection', () => {
  const qm = new QualityMonitor();
  // Single-call turn primes lastCallSignature
  qm.inspect({
    message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    knownTools: ['read_file'],
  });
  // Two-call turn — not a repeat candidate
  const t2 = qm.inspect({
    message: {
      content: '',
      tool_calls: [
        { function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { function: { name: 'patch', arguments: '{"path":"a","old_str":"x","new_str":"y"}' } },
      ],
    },
    knownTools: ['read_file', 'patch'],
  });
  assert.equal(t2, null);
});

test('correction spiral is capped at MAX_CORRECTIONS', () => {
  const qm = new QualityMonitor();
  let fires = 0;
  for (let i = 0; i < MAX_CORRECTIONS + 2; i++) {
    const sig = qm.inspect({ message: { content: '', tool_calls: [] }, knownTools: ['read_file'] });
    if (sig) fires += 1;
  }
  assert.ok(fires <= MAX_CORRECTIONS, `should fire at most ${MAX_CORRECTIONS}, got ${fires}`);
});

test('aborted turn skips quality checks (avoids spurious empty_response)', () => {
  const qm = new QualityMonitor();
  const sig = qm.inspect({
    message: { content: '', tool_calls: [] },
    knownTools: ['read_file'],
    aborted: true,
  });
  assert.equal(sig, null);
});

test('reset() clears consecutive corrections and signature window', () => {
  const qm = new QualityMonitor();
  qm.inspect({ message: { content: '', tool_calls: [] }, knownTools: ['read_file'] });
  qm.reset();
  // After reset, the prior empty-response state should not count toward the cap.
  const sig = qm.inspect({ message: { content: '', tool_calls: [] }, knownTools: ['read_file'] });
  assert.ok(sig);
  assert.equal(sig.kind, 'empty_response');
});

test('_editDistance handles trivial cases', () => {
  assert.equal(_editDistance('', ''), 0);
  assert.equal(_editDistance('a', ''), 1);
  assert.equal(_editDistance('', 'b'), 1);
  assert.equal(_editDistance('cat', 'cat'), 0);
  assert.equal(_editDistance('cat', 'cot'), 1);
  assert.equal(_editDistance('read_file', 'red_file'), 1);
});
