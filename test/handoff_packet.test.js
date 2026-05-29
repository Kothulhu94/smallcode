// Milestone 12 — Specialist Handoff Packets Unit and Integration Tests

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHandoffPacket,
  validateHandoffPacket,
  compactHandoffPacket,
  summarizeFailureState,
  summarizeToolAttempts,
  renderHandoffForPrompt
} = require('../src/governor/handoff_packet');

const { RunLedger } = require('../src/governor/run_ledger');
const { buildSystemPrompt } = require('../bin/model_client');

test('Handoff Packet - createHandoffPacket required and optional fields', () => {
  const input = {
    runId: 'test-run-123',
    fromAgentId: 'code_editor',
    toAgentId: 'architect',
    taskType: 'coding',
    reason: 'repeated_patch_failure',
    summary: 'Patch failed twice because old_str was not found.',
    userMessage: 'Avoid editing original test files. Keep original architecture.',
    failureState: {
      denials: 1,
      testFailures: 2,
      toolFailures: {
        patch: ['err1', 'err2']
      }
    },
    editedFiles: ['src/main.js', 'src/utils.js'],
    modelPresetBefore: 'default',
    modelPresetAfter: 'strong'
  };

  const packet = createHandoffPacket(input);

  assert.ok(packet.id);
  assert.equal(packet.runId, 'test-run-123');
  assert.equal(packet.fromAgentId, 'code_editor');
  assert.equal(packet.toAgentId, 'architect');
  assert.equal(packet.reason, 'repeated_patch_failure');
  assert.equal(packet.severity, 'medium');
  assert.equal(packet.userPromptPreview, 'Avoid editing original test files. Keep original architecture.');
  assert.equal(packet.summary, 'Patch failed twice because old_str was not found.');
  assert.ok(packet.failureSummary.includes('1 denials'));
  assert.ok(packet.failureSummary.includes('2 test failures'));
  assert.deepEqual(packet.attemptedTools, ['patch failed 2 times']);
  assert.deepEqual(packet.relevantFiles, ['src/main.js', 'src/utils.js']);
  assert.equal(packet.modelPresetBefore, 'default');
  assert.equal(packet.modelPresetAfter, 'strong');
  assert.ok(packet.constraints.includes('avoid editing original test files'));
  assert.ok(packet.recommendedAction);
});

test('Handoff Packet - validateHandoffPacket rules', () => {
  const validPacket = {
    id: 'hop_123',
    createdAt: Date.now(),
    fromAgentId: 'code_editor',
    toAgentId: 'architect',
    reason: 'patch_failure',
    summary: 'Encountered patch failure twice',
    recommendedAction: 'Verify target search blocks'
  };

  assert.ok(validateHandoffPacket(validPacket));

  // Missing fields should throw
  const invalidPacket = { ...validPacket };
  delete invalidPacket.fromAgentId;

  assert.throws(() => {
    validateHandoffPacket(invalidPacket);
  }, /Missing required handoff packet field: fromAgentId/);
});

test('Handoff Packet - compactHandoffPacket limits fields and arrays', () => {
  const longString = 'a'.repeat(300);
  const packet = {
    id: 'hop_123',
    createdAt: Date.now(),
    fromAgentId: 'code_editor',
    toAgentId: 'architect',
    reason: 'patch_failure',
    summary: longString,
    recommendedAction: 'Verify target search blocks',
    attemptedTools: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
    relevantFiles: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'],
    base64: 'heavy_base64_data',
    imageData: 'image_bytes'
  };

  const compacted = compactHandoffPacket(packet);

  assert.equal(compacted.summary.length, 203); // 200 + '...'
  assert.equal(compacted.attemptedTools.length, 6); // 5 + '...'
  assert.equal(compacted.attemptedTools[5], '...');
  assert.equal(compacted.relevantFiles.length, 6);
  assert.equal(compacted.relevantFiles[5], '...');
  assert.equal(compacted.base64, undefined);
  assert.equal(compacted.imageData, undefined);
});

test('Handoff Packet - renderHandoffForPrompt format', () => {
  const packet = {
    fromAgentId: 'code_editor',
    toAgentId: 'architect',
    reason: 'repeated_patch_failure',
    summary: 'Patch failed twice because old_str was not found.',
    attemptedTools: ['patch failed 2 times'],
    relevantFiles: ['src/main.js'],
    constraints: 'avoid editing tests',
    recommendedAction: 'inspect target file and produce safer patch plan'
  };

  const rendered = renderHandoffForPrompt(packet);
  
  assert.ok(rendered.includes('[HANDOFF]'));
  assert.ok(rendered.includes('from: code_editor'));
  assert.ok(rendered.includes('to: architect'));
  assert.ok(rendered.includes('reason: repeated_patch_failure'));
  assert.ok(rendered.includes('summary: Patch failed twice because old_str was not found.'));
  assert.ok(rendered.includes('attempted: patch failed 2 times'));
  assert.ok(rendered.includes('relevant_files: src/main.js'));
  assert.ok(rendered.includes('constraints: avoid editing tests'));
  assert.ok(rendered.includes('recommended_action: inspect target file and produce safer patch plan'));
  assert.ok(rendered.includes('[/HANDOFF]'));
});

test('Handoff Packet - summarizeToolAttempts and failureState', () => {
  const events = [
    { tool_name: 'patch', success: 0 },
    { tool_name: 'patch', success: 0 },
    { tool_name: 'bash', success: 1 },
    { tool_name: 'bash', success: 0 }
  ];

  const summarized = summarizeToolAttempts(events);
  assert.deepEqual(summarized, ['patch failed 2 times', 'bash failed 1 time']);

  const failureState = {
    denials: 2,
    testFailures: 0,
    consecutiveNoProgress: 1,
    toolFailures: {}
  };
  const summaryStr = summarizeFailureState(failureState);
  assert.ok(summaryStr.includes('2 denials'));
  assert.ok(summaryStr.includes('1 consecutive no-progress turns'));
  assert.ok(!summaryStr.includes('failures'));
});

test('Handoff Packet - recommendedAction for vision and other failures', () => {
  const packetVision = createHandoffPacket({
    reason: 'vision_unsupported',
    fromAgentId: 'visual_observer',
    toAgentId: 'conductor'
  });
  assert.ok(packetVision.recommendedAction.includes('Continue without image analysis'));

  const packetMaxCalls = createHandoffPacket({
    reason: 'max_tool_calls',
    fromAgentId: 'code_editor',
    toAgentId: 'architect'
  });
  assert.ok(packetMaxCalls.recommendedAction.includes('Decompose the current task'));
});

test('Milestone 12 - Handoff step recording in ledger alongside escalation', () => {
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();
  const runId = ledger.startRun({ prompt: 'test' });

  // Record agent_escalation
  ledger.recordStep({
    runId,
    stepIndex: 0,
    stepType: 'agent_escalation',
    name: 'code_editor -> architect',
    summary: 'Escalated from Code Editor to Architect.'
  });

  // Record agent_handoff
  ledger.recordStep({
    runId,
    stepIndex: 1,
    stepType: 'agent_handoff',
    name: 'code_editor -> architect',
    summary: '[HANDOFF]\nfrom: code_editor\nto: architect\nreason: repeated_patch_failure\n[/HANDOFF]'
  });

  const run = ledger.getRun(runId);
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].step_type, 'agent_escalation');
  assert.equal(run.steps[1].step_type, 'agent_handoff');
  assert.ok(run.steps[1].summary.includes('[HANDOFF]'));
  ledger.close();
});

test('Milestone 12 - Prompt construction includes handoff block', () => {
  const mockCtx = {
    config: {
      activeHandoffPrompt: '[HANDOFF]\nfrom: code_editor\nto: architect\nreason: repeated_patch_failure\n[/HANDOFF]'
    },
    conversationHistory: [],
    currentTaskType: 'coding'
  };
  const prompt = buildSystemPrompt(mockCtx);
  assert.ok(prompt.includes('[HANDOFF]'));
  assert.ok(prompt.includes('from: code_editor'));
  assert.ok(prompt.includes('to: architect'));
});
