// Milestone 11 — Failure Recovery + Escalation Policy Tests
//
// Verifies:
// 1. createFailureState returns the correct initial state.
// 2. areErrorsSimilar correctly compares error strings after normalization.
// 3. classifyFailureEvent classifies failure events correctly.
// 4. updateFailureState modifies the state correctly.
// 5. shouldEscalate triggers on all expected failure patterns.
// 6. resolveEscalationTarget resolves correct next targets.
// 7. buildEscalationSummary outputs the correct structured summary.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFailureState,
  areErrorsSimilar,
  classifyFailureEvent,
  updateFailureState,
  shouldEscalate,
  resolveEscalationTarget,
  buildEscalationSummary
} = require('../src/governor/escalation_policy');

test('Escalation Policy - createFailureState initial values', () => {
  const state = createFailureState();
  assert.equal(state.denials, 0);
  assert.deepEqual(state.toolFailures, {});
  assert.equal(state.testFailures, 0);
  assert.equal(state.consecutiveNoProgress, 0);
  assert.equal(state.maxToolCallHits, 0);
  assert.equal(state.visionUnsupported, 0);
  assert.equal(state.screenshotFailures, 0);
  assert.equal(state.modelFailures, 0);
  assert.deepEqual(state.pastEscalations, []);
  assert.deepEqual(state.recentEvents, []);
});

test('Escalation Policy - areErrorsSimilar normalization', () => {
  // Test paths removal
  const err1 = 'Error: failed in C:\\Users\\Name\\Project\\file.js:12:4';
  const err2 = 'Error: failed in /usr/local/bin/file.js:45';
  assert.ok(areErrorsSimilar(err1, err2));

  // Test hex / uuid / timestamp removal
  const hexErr1 = 'Database error at 0x7FFF1234ADF: connection timed out';
  const hexErr2 = 'Database error at 0x1234ABC: connection timed out';
  assert.ok(areErrorsSimilar(hexErr1, hexErr2));

  const uuidErr1 = 'Task 9f8a3c4b-12d3-4f5e-a6b7-8c9d0e1f2a3b failed';
  const uuidErr2 = 'Task 0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d failed';
  assert.ok(areErrorsSimilar(uuidErr1, uuidErr2));

  const timeErr1 = 'Sync failed at 2026-05-29T01:15:30.123Z';
  const timeErr2 = 'Sync failed at 2026-05-28T22:30:15Z';
  assert.ok(areErrorsSimilar(timeErr1, timeErr2));

  // Structurally different errors
  assert.ok(!areErrorsSimilar('SyntaxError: unexpected token', 'TimeoutError: server did not respond'));
});

test('Escalation Policy - classifyFailureEvent rules', () => {
  // Model failures
  assert.equal(classifyFailureEvent({ type: 'model_failure' }), 'model_failure');
  // No progress
  assert.equal(classifyFailureEvent({ type: 'no_progress' }), 'no_progress');
  // Max tool calls
  assert.equal(classifyFailureEvent({ type: 'max_tool_calls' }), 'max_tool_calls');

  // Tool executions
  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'read_file',
    result: { error: 'Permission denied' }
  }), 'authorization_denial');

  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'vision_describe',
    result: { error: 'Vision input is not supported by the active model endpoint' }
  }), 'vision_unsupported');

  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'vision_screenshot',
    result: { error: 'Failed to capture screenshot' }
  }), 'screenshot_failure');

  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'bash',
    args: { command: 'npm test' },
    result: { error: 'Tests failed' }
  }), 'test_failure');

  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'patch',
    result: { error: 'Target block not found' }
  }), 'patch_failure');

  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'bash',
    args: { command: 'node script.js' },
    result: { error: 'Execution failed' }
  }), 'shell_failure');

  // Success
  assert.equal(classifyFailureEvent({
    type: 'tool_execution',
    name: 'read_file',
    result: { result: 'file content' }
  }), null);
});

test('Escalation Policy - updateFailureState increments', () => {
  let state = createFailureState();

  // Test no-progress increment
  state = updateFailureState(state, { type: 'no_progress' });
  assert.equal(state.consecutiveNoProgress, 1);

  // Test no-progress reset on success
  state = updateFailureState(state, {
    type: 'tool_execution',
    name: 'read_file',
    result: { result: 'file content' }
  });
  assert.equal(state.consecutiveNoProgress, 0);

  // Test denials increment
  state = updateFailureState(state, {
    type: 'tool_execution',
    name: 'write_file',
    result: { error: 'not authorized' }
  });
  assert.equal(state.denials, 1);

  // Test tool failures tracking
  assert.deepEqual(state.toolFailures['write_file'], ['not authorized']);
});

test('Escalation Policy - shouldEscalate conditions', () => {
  const activeAgent = { agentId: 'code_editor', name: 'Code Editor' };

  // 1. Authorization denials (>= 2)
  let state = createFailureState();
  assert.equal(shouldEscalate(state, activeAgent).escalate, false);
  state.denials = 2;
  let esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'authorization_denial');

  // 2. Repeated tool failure (same/similar error twice)
  state = createFailureState();
  state.toolFailures['read_file'] = ['failed to read /a/b.txt', 'failed to read /c/d.txt'];
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'repeated_tool_failure');

  // 3. Patch failures for code_editor (>= 2)
  state = createFailureState();
  state.toolFailures['patch'] = ['err1'];
  state.toolFailures['write_file'] = ['err2'];
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'patch_failure');

  // 4. Test failures (>= 2)
  state = createFailureState();
  state.testFailures = 2;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'test_failure');

  // 5. No progress loop (>= 2)
  state = createFailureState();
  state.consecutiveNoProgress = 2;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'no_progress');

  // 6. Max tool calls (>= 1)
  state = createFailureState();
  state.maxToolCallHits = 1;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'max_tool_calls');

  // 7. Vision unsupported (>= 2)
  state = createFailureState();
  state.visionUnsupported = 2;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'vision_unsupported');

  // 8. Screenshot failures (>= 2)
  state = createFailureState();
  state.screenshotFailures = 2;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'screenshot_failure');

  // 9. Visual task needed mismatch
  state = createFailureState();
  state.denials = 1;
  esc = shouldEscalate(state, activeAgent, { userMessage: 'describe this screenshot please' });
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'visual_task_needed');

  // 10. Model failures (>= 2)
  state = createFailureState();
  state.modelFailures = 2;
  esc = shouldEscalate(state, activeAgent);
  assert.equal(esc.escalate, true);
  assert.equal(esc.reason, 'model_failure');
});

test('Escalation Policy - resolveEscalationTarget logic', () => {
  // Escalating from code_editor on patch_failure goes to architect
  let res = resolveEscalationTarget('code_editor', 'patch_failure', { pastEscalations: [] });
  assert.equal(res.target, 'architect');

  // Escalating from qa_tester on test_failure goes to architect
  res = resolveEscalationTarget('qa_tester', 'test_failure', { pastEscalations: [] });
  assert.equal(res.target, 'architect');

  // Escalating from conductor goes to terminal human review
  res = resolveEscalationTarget('conductor', 'no_progress', { pastEscalations: [] });
  assert.equal(res.terminal, true);

  // If already escalated to architect, escalate to conductor
  res = resolveEscalationTarget('architect', 'patch_failure', {
    pastEscalations: [{ from: 'code_editor', to: 'architect', reason: 'patch_failure' }]
  });
  assert.equal(res.target, 'conductor');

  // Prevent self-escalation
  res = resolveEscalationTarget('architect', 'patch_failure', { pastEscalations: [] });
  assert.equal(res.target, 'conductor');
});

test('Escalation Policy - buildEscalationSummary layout', () => {
  const state = createFailureState();
  const decision = {
    from: 'code_editor',
    target: 'architect',
    reason: 'patch_failure',
    summary: 'Code Editor encountered 2 file edit/patch failures.'
  };

  const summary = buildEscalationSummary(state, decision);
  assert.ok(summary.includes('[ESCALATION]'));
  assert.ok(summary.includes('from: code_editor'));
  assert.ok(summary.includes('to: architect'));
  assert.ok(summary.includes('reason: patch_failure'));
  assert.ok(summary.includes('summary: Code Editor encountered 2 file edit/patch failures.'));
  assert.ok(summary.includes('instruction: diagnose cause and choose the safest next action'));
  assert.ok(summary.includes('[/ESCALATION]'));
});
