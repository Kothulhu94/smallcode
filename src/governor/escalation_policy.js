// SmallCode — Failure Recovery + Escalation Policy Module (Milestone 11)

'use strict';

/**
 * Returns the initial failure state object.
 */
function createFailureState() {
  return {
    denials: 0,
    toolFailures: {},
    testFailures: 0,
    consecutiveNoProgress: 0,
    maxToolCallHits: 0,
    visionUnsupported: 0,
    screenshotFailures: 0,
    modelFailures: 0,
    pastEscalations: [],
    recentEvents: []
  };
}

/**
 * Normalizes error messages for comparison.
 */
function normalizeError(err) {
  if (!err) return '';
  let str = String(err).toLowerCase().trim();

  // Remove timestamps (hh:mm:ss and ISO dates) first so colons inside them are preserved
  str = str.replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?z?\b/g, '[datetime]');
  str = str.replace(/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, '[time]');

  // Remove absolute paths (Windows/Unix basenames)
  str = str.replace(/[a-zA-Z]:\\[^:\s]+/g, '[path]');
  str = str.replace(/\/[\w.\/-]+/g, '[path]');

  // Remove line/column numbers
  str = str.replace(/:\d+(:\d+)?/g, '');
  str = str.replace(/line \d+/g, '');

  // Remove hex IDs / UUIDs
  str = str.replace(/0x[0-9a-fA-F]+/g, '[hex]');
  str = str.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '[uuid]');

  // Collapse consecutive whitespace
  str = str.replace(/\s+/g, ' ');

  return str.trim();
}

/**
 * Checks if two error strings are structurally similar.
 */
function areErrorsSimilar(err1, err2) {
  const n1 = normalizeError(err1);
  const n2 = normalizeError(err2);
  if (!n1 || !n2) return false;
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

/**
 * Classifies raw failure events into normalized type strings.
 */
function classifyFailureEvent(event) {
  if (!event) return 'unknown_failure';

  if (event.type === 'model_failure') {
    return 'model_failure';
  }

  if (event.type === 'no_progress') {
    return 'no_progress';
  }

  if (event.type === 'max_tool_calls') {
    return 'max_tool_calls';
  }

  if (event.type === 'tool_execution') {
    const name = event.name;
    const result = event.result || {};
    const errorMsg = result.error || '';
    const command = event.args?.command || '';

    if (!errorMsg) {
      return null; // Successful execution, no failure
    }

    // Authorization denial check
    if (errorMsg.includes('denied') || errorMsg.includes('not authorized') || errorMsg.includes('not whitelisted')) {
      return 'authorization_denial';
    }

    // Vision unsupported check
    if (errorMsg.includes('Vision input is not supported') || errorMsg.includes('cannot analyze images')) {
      return 'vision_unsupported';
    }

    // Screenshot capture failure check
    if (name === 'vision_screenshot') {
      return 'screenshot_failure';
    }

    // Test failure check
    const isTestCmd = /\b(test|pytest|jest|vitest|npm\s+test|run-tests)\b/i.test(command);
    if ((name === 'bash' || name === 'run') && isTestCmd) {
      return 'test_failure';
    }

    // Patch failure check
    if (name === 'patch' || name === 'read_and_patch') {
      return 'patch_failure';
    }

    // Shell failure check
    if (name === 'bash' || name === 'run') {
      return 'shell_failure';
    }

    return 'tool_failure';
  }

  return 'unknown_failure';
}

/**
 * Updates failure state based on classified events.
 */
function updateFailureState(state, event) {
  const type = classifyFailureEvent(event);
  if (!type) {
    // Reset no progress count on successful tool execution
    if (event && event.type === 'tool_execution' && event.result && !event.result.error) {
      state.consecutiveNoProgress = 0;
    }
    return state;
  }

  state.recentEvents.push({ type, toolName: event.name, error: event.result?.error, timestamp: Date.now() });
  if (state.recentEvents.length > 20) {
    state.recentEvents.shift();
  }

  if (type === 'authorization_denial') {
    state.denials++;
  } else if (type === 'test_failure') {
    state.testFailures++;
  } else if (type === 'no_progress') {
    state.consecutiveNoProgress++;
  } else if (type === 'max_tool_calls') {
    state.maxToolCallHits++;
  } else if (type === 'vision_unsupported') {
    state.visionUnsupported++;
  } else if (type === 'screenshot_failure') {
    state.screenshotFailures++;
  } else if (type === 'model_failure') {
    state.modelFailures++;
  }

  if (event.name) {
    const errorMsg = event.result?.error || 'Unknown error';
    if (!state.toolFailures[event.name]) {
      state.toolFailures[event.name] = [];
    }
    state.toolFailures[event.name].push(errorMsg);
  }

  if (event.type === 'tool_execution' && event.result && !event.result.error) {
    state.consecutiveNoProgress = 0;
  }

  return state;
}

/**
 * Determines if failure recovery escalation rules should fire.
 */
function shouldEscalate(state, activeAgent, context) {
  const currentId = activeAgent?.agentId || activeAgent?.id || activeAgent || '';

  // 1. Authorization denials
  if (state.denials >= 2) {
    return {
      escalate: true,
      reason: 'authorization_denial',
      summary: `Active agent '${currentId}' received ${state.denials} authorization denials.`
    };
  }

  // 2. Repeated same tool failure
  for (const [toolName, errors] of Object.entries(state.toolFailures)) {
    if (errors.length >= 2) {
      for (let i = 0; i < errors.length; i++) {
        for (let j = i + 1; j < errors.length; j++) {
          if (areErrorsSimilar(errors[i], errors[j])) {
            return {
              escalate: true,
              reason: 'repeated_tool_failure',
              toolName,
              summary: `Tool '${toolName}' failed twice with similar error: "${errors[j]}"`
            };
          }
        }
      }
    }
  }

  // 3. Patch/edit failure
  if (currentId === 'code_editor') {
    const editFailures = (state.toolFailures['patch']?.length || 0) +
                         (state.toolFailures['write_file']?.length || 0) +
                         (state.toolFailures['append_file']?.length || 0) +
                         (state.toolFailures['read_and_patch']?.length || 0);
    if (editFailures >= 2) {
      return {
        escalate: true,
        reason: 'patch_failure',
        summary: `Code Editor encountered ${editFailures} file edit/patch failures.`
      };
    }
  }

  // 4. Test failure
  if (state.testFailures >= 2) {
    if (currentId === 'qa_tester' || currentId === 'code_editor') {
      return {
        escalate: true,
        reason: 'test_failure',
        summary: `Active agent '${currentId}' triggered ${state.testFailures} test failures.`
      };
    }
  }

  // 5. No-progress loop
  if (state.consecutiveNoProgress >= 2) {
    return {
      escalate: true,
      reason: 'no_progress',
      summary: `Model produced no tool calls and no useful output for 2 consecutive turns.`
    };
  }

  // 6. Max tool calls
  if (state.maxToolCallHits >= 1) {
    return {
      escalate: true,
      reason: 'max_tool_calls',
      summary: `Max tool call limit was reached.`
    };
  }

  // 7. Vision unsupported
  if (state.visionUnsupported >= 2) {
    return {
      escalate: true,
      reason: 'vision_unsupported',
      summary: `Vision tool returned unsupported capability twice.`
    };
  }

  // 8. Screenshot failure
  if (state.screenshotFailures >= 2) {
    return {
      escalate: true,
      reason: 'screenshot_failure',
      summary: `Screenshot capture failed ${state.screenshotFailures} times.`
    };
  }

  // 9. Visual task needed mismatch
  const userMsgLower = String(context?.userMessage || '').toLowerCase();
  const hasVisualKeywords = /\b(screenshot|image|layout|visual|ui|describe\s+image|describe\s+screenshot)\b/i.test(userMsgLower);
  const isVisualAgent = ['visual_observer', 'conductor', 'qa_tester', 'architect'].includes(currentId);
  if (hasVisualKeywords && !isVisualAgent && (state.denials >= 1 || state.toolFailures['vision_screenshot']?.length >= 1 || state.toolFailures['vision_describe']?.length >= 1 || state.toolFailures['vision_ask']?.length >= 1)) {
    return {
      escalate: true,
      reason: 'visual_task_needed',
      summary: `Task mentions visual terms, but active agent is '${currentId}'.`
    };
  }

  // 10. Model failure
  if (state.modelFailures >= 2) {
    return {
      escalate: true,
      reason: 'model_failure',
      summary: `Model endpoint or network connection failed ${state.modelFailures} times.`
    };
  }

  return { escalate: false };
}

/**
 * Resolves the next agent target for escalation.
 */
function resolveEscalationTarget(activeAgent, reasonType, context) {
  const currentId = activeAgent?.agentId || activeAgent?.id || activeAgent || '';
  const pastEscalations = context?.pastEscalations || [];

  if (currentId === 'conductor') {
    return { target: null, terminal: true, reason: 'human_review_required' };
  }

  if (pastEscalations.some(esc => esc.to === 'conductor')) {
    return { target: null, terminal: true, reason: 'human_review_required' };
  }

  let target = 'conductor'; // default fallback

  if (reasonType === 'authorization_denial') {
    const toolName = context?.toolName || '';
    const isFileEdit = ['write_file', 'append_file', 'patch', 'read_and_patch', 'create_and_run'].includes(toolName);
    const isShell = ['bash', 'run'].includes(toolName);
    if (isFileEdit) {
      target = 'code_editor';
    } else if (isShell) {
      target = 'qa_tester';
    } else {
      target = 'conductor';
    }
  } else if (reasonType === 'repeated_tool_failure') {
    const toolName = context?.toolName;
    const isFileEdit = ['write_file', 'append_file', 'patch', 'read_and_patch', 'create_and_run'].includes(toolName);
    if (currentId === 'code_editor' && isFileEdit) {
      target = 'architect';
    } else {
      target = 'conductor';
    }
  } else if (reasonType === 'test_failure') {
    if (currentId === 'qa_tester' || currentId === 'code_editor') {
      target = 'architect';
    } else {
      target = 'conductor';
    }
  } else if (reasonType === 'patch_failure') {
    target = 'architect';
  } else if (reasonType === 'no_progress') {
    target = 'conductor';
  } else if (reasonType === 'max_tool_calls') {
    if (currentId === 'code_editor' || currentId === 'qa_tester') {
      target = 'architect';
    } else {
      target = 'conductor';
    }
  } else if (reasonType === 'vision_unsupported') {
    target = 'conductor';
  } else if (reasonType === 'screenshot_failure') {
    target = 'conductor';
  } else if (reasonType === 'visual_task_needed') {
    target = 'visual_observer';
  } else if (reasonType === 'model_failure') {
    target = 'conductor';
  }

  // Prevent self-escalation
  if (target === currentId) {
    if (currentId === 'architect') {
      return { target: 'conductor', reason: 'architect_failed_recovery' };
    }
    return { target: 'conductor' };
  }

  // If already escalated to architect once, escalate to conductor
  if (target === 'architect' && pastEscalations.some(esc => esc.to === 'architect')) {
    return { target: 'conductor', reason: 'architect_failed_recovery' };
  }

  return { target };
}

/**
 * Builds the compact escalation prompt injection string.
 */
function buildEscalationSummary(state, decision) {
  const from = decision.from || 'unknown';
  const to = decision.target || 'unknown';
  let reason = decision.reason || 'unknown_failure';
  
  if (reason === 'vision_unsupported') {
    reason = 'vision_capability_unavailable';
  }

  let instruction = 'diagnose cause and plan the next recovery steps';
  if (reason === 'vision_capability_unavailable') {
    instruction = 'continue without image analysis, switch model only if configured, or ask the user for direction';
  } else if (reason === 'authorization_denial') {
    instruction = 'review tool permissions and request authorization or use standard allowed tools';
  } else if (['test_failure', 'patch_failure', 'repeated_tool_failure'].includes(reason)) {
    instruction = 'diagnose cause and choose the safest next action';
  }

  const summary = decision.summary || 'encountered repeated errors';

  return `[ESCALATION]
from: ${from}
to: ${to}
reason: ${reason}
summary: ${summary}
instruction: ${instruction}
[/ESCALATION]`;
}

module.exports = {
  createFailureState,
  areErrorsSimilar,
  classifyFailureEvent,
  updateFailureState,
  shouldEscalate,
  resolveEscalationTarget,
  buildEscalationSummary
};
