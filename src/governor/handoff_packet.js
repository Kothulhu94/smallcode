// SmallCode — Specialist Handoff Packets Module (Milestone 12)

'use strict';

const crypto = require('crypto');

function generateId() {
  if (crypto.randomUUID) return 'hop_' + crypto.randomUUID().slice(0, 8);
  return 'hop_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Summarizes failure state counts.
 */
function summarizeFailureState(failureState) {
  if (!failureState) return '';
  const parts = [];
  if (failureState.denials) parts.push(`${failureState.denials} denials`);
  if (failureState.testFailures) parts.push(`${failureState.testFailures} test failures`);
  if (failureState.consecutiveNoProgress) parts.push(`${failureState.consecutiveNoProgress} consecutive no-progress turns`);
  if (failureState.maxToolCallHits) parts.push(`${failureState.maxToolCallHits} max tool call hits`);
  if (failureState.visionUnsupported) parts.push(`${failureState.visionUnsupported} vision unsupported errors`);
  if (failureState.screenshotFailures) parts.push(`${failureState.screenshotFailures} screenshot failures`);
  if (failureState.modelFailures) parts.push(`${failureState.modelFailures} model failures`);

  if (failureState.toolFailures) {
    let toolFailCount = 0;
    for (const [_, errors] of Object.entries(failureState.toolFailures)) {
      if (errors && errors.length > 0) {
        toolFailCount += errors.length;
      }
    }
    if (toolFailCount > 0) {
      parts.push(`${toolFailCount} tool failures`);
    }
  }

  return parts.join(', ');
}

/**
 * Maps failed ledger tool calls to a list of attempt descriptions.
 */
function summarizeToolAttempts(toolEvents) {
  if (!Array.isArray(toolEvents)) return [];
  const failed = toolEvents.filter(tc => tc.success === 0 || !tc.success);
  const counts = {};
  failed.forEach(tc => {
    counts[tc.tool_name] = (counts[tc.tool_name] || 0) + 1;
  });
  return Object.entries(counts).map(([name, cnt]) => `${name} failed ${cnt} time${cnt > 1 ? 's' : ''}`);
}

/**
 * Fallback to get attempted tools from failureState.
 */
function getAttemptedToolsFromFailureState(failureState) {
  if (!failureState || !failureState.toolFailures) return [];
  return Object.entries(failureState.toolFailures)
    .filter(([_, errs]) => errs && errs.length > 0)
    .map(([name, errs]) => `${name} failed ${errs.length} time${errs.length > 1 ? 's' : ''}`);
}

/**
 * Recommends an action based on escalation reason.
 */
function getRecommendedAction(reason) {
  if (reason === 'authorization_denial') {
    return 'Request manual user authorization or use other standard allowed tools.';
  }
  if (reason === 'repeated_tool_failure') {
    return 'Check tool arguments, verify dependencies are installed, or troubleshoot shell execution details.';
  }
  if (reason === 'patch_failure') {
    return 'Verify target search blocks, examine lines to edit, and construct a precise file update.';
  }
  if (reason === 'test_failure') {
    return 'Investigate test failures, examine recent changes, and resolve bugs in the modified codebase.';
  }
  if (reason === 'no_progress') {
    return 'Change the approach, refine inputs, or ask the user for clarifying guidelines.';
  }
  if (reason === 'max_tool_calls') {
    return 'Decompose the current task into smaller steps and execute with fresh tools context.';
  }
  if (reason === 'vision_unsupported') {
    return 'Continue without image analysis, switch model if configured, or request manual clarification.';
  }
  if (reason === 'screenshot_failure') {
    return 'Check python dependency and PIL module, or proceed without visual validation.';
  }
  if (reason === 'visual_task_needed') {
    return 'Use vision tools to inspect UI layout and visual state of the workspace.';
  }
  if (reason === 'model_failure') {
    return 'Verify LLM endpoint status, check connection settings, or use alternative models.';
  }
  return 'Diagnose failure cause and plan recovery steps.';
}

/**
 * Creates a plain handoff packet object.
 */
function createHandoffPacket(input = {}) {
  const reason = input.reason || 'unknown_failure';
  
  // Severity mapping
  let severity = 'medium';
  if (reason === 'authorization_denial' || reason === 'max_tool_calls' || reason === 'test_failure') {
    severity = 'high';
  } else if (reason === 'model_failure') {
    severity = 'critical';
  } else if (reason === 'vision_unsupported' || reason === 'visual_task_needed') {
    severity = 'low';
  }

  // Attempted tools
  let attemptedTools = [];
  if (Array.isArray(input.toolEvents)) {
    attemptedTools = summarizeToolAttempts(input.toolEvents);
  } else if (input.failureState) {
    attemptedTools = getAttemptedToolsFromFailureState(input.failureState);
  }

  // Memory summary
  let memorySummary = '';
  if (Array.isArray(input.memoryEvents) && input.memoryEvents.length > 0) {
    const totalItems = input.memoryEvents.reduce((acc, ev) => acc + (ev.items_loaded || 0), 0);
    const totalTokens = input.memoryEvents.reduce((acc, ev) => acc + (ev.tokens_used || 0), 0);
    memorySummary = `Loaded ${totalItems} memories (${totalTokens} tokens) across ${input.memoryEvents.length} queries.`;
  }

  // Constraints
  let constraints = '';
  if (input.userMessage) {
    const userMsgLower = String(input.userMessage).toLowerCase();
    const matches = userMsgLower.match(/\b(preserve|dont|do not|avoid|must not)\b[^.!?]*/gi);
    if (matches) {
      constraints = matches.slice(0, 3).map(m => m.trim()).join('; ');
    }
  }

  const packet = {
    id: generateId(),
    runId: input.runId || null,
    createdAt: Date.now(),
    fromAgentId: input.fromAgentId || 'unknown',
    toAgentId: input.toAgentId || 'unknown',
    taskType: input.taskType || null,
    reason,
    severity,
    userPromptPreview: input.userMessage ? String(input.userMessage).slice(0, 100) : null,
    summary: input.summary || 'encountered repeated errors',
    failureSummary: summarizeFailureState(input.failureState),
    attemptedTools,
    relevantFiles: Array.isArray(input.editedFiles) ? [...new Set(input.editedFiles)] : [],
    memorySummary: memorySummary || null,
    constraints: constraints || null,
    recommendedAction: input.recommendedAction || getRecommendedAction(reason),
    modelPresetBefore: input.modelPresetBefore || null,
    modelPresetAfter: input.modelPresetAfter || null,
    ledgerRefs: input.ledgerRefs || []
  };

  return compactHandoffPacket(packet);
}

/**
 * Validates the handoff packet required fields.
 */
function validateHandoffPacket(packet) {
  if (!packet) throw new Error('Handoff packet is null or undefined');
  const required = ['id', 'createdAt', 'fromAgentId', 'toAgentId', 'reason', 'summary', 'recommendedAction'];
  for (const field of required) {
    if (packet[field] === undefined || packet[field] === null || packet[field] === '') {
      throw new Error(`Missing required handoff packet field: ${field}`);
    }
  }
  return true;
}

/**
 * Safely compacts and truncates handoff packet content.
 */
function compactHandoffPacket(packet, options = {}) {
  if (!packet) return null;
  const copy = JSON.parse(JSON.stringify(packet));

  const maxStrLen = options.maxStrLen || 200;
  const fieldsToTruncate = ['summary', 'failureSummary', 'constraints', 'recommendedAction', 'userPromptPreview'];
  fieldsToTruncate.forEach(f => {
    if (typeof copy[f] === 'string' && copy[f].length > maxStrLen) {
      copy[f] = copy[f].slice(0, maxStrLen) + '...';
    }
  });

  const maxArrayLen = options.maxArrayLen || 5;
  if (Array.isArray(copy.attemptedTools) && copy.attemptedTools.length > maxArrayLen) {
    copy.attemptedTools = copy.attemptedTools.slice(0, maxArrayLen);
    copy.attemptedTools.push('...');
  }
  if (Array.isArray(copy.relevantFiles) && copy.relevantFiles.length > maxArrayLen) {
    copy.relevantFiles = copy.relevantFiles.slice(0, maxArrayLen);
    copy.relevantFiles.push('...');
  }

  // Remove any heavy data
  delete copy.base64;
  delete copy.imageData;
  delete copy.screenshotData;

  return copy;
}

/**
 * Formats handoff packet for system prompt injection.
 */
function renderHandoffForPrompt(packet) {
  if (!packet) return '';
  const lines = ['[HANDOFF]'];
  if (packet.fromAgentId) lines.push(`from: ${packet.fromAgentId}`);
  if (packet.toAgentId) lines.push(`to: ${packet.toAgentId}`);
  if (packet.reason) lines.push(`reason: ${packet.reason}`);
  if (packet.summary) lines.push(`summary: ${packet.summary}`);
  
  if (packet.attemptedTools && packet.attemptedTools.length > 0) {
    lines.push(`attempted: ${packet.attemptedTools.join(', ')}`);
  }
  if (packet.relevantFiles && packet.relevantFiles.length > 0) {
    lines.push(`relevant_files: ${packet.relevantFiles.join(', ')}`);
  }
  if (packet.constraints) lines.push(`constraints: ${packet.constraints}`);
  if (packet.recommendedAction) lines.push(`recommended_action: ${packet.recommendedAction}`);
  lines.push('[/HANDOFF]');
  return lines.join('\n');
}

module.exports = {
  createHandoffPacket,
  validateHandoffPacket,
  compactHandoffPacket,
  summarizeFailureState,
  summarizeToolAttempts,
  renderHandoffForPrompt
};
