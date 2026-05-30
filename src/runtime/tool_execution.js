const { executeTool: _executeToolModule } = require('../../bin/executor');
const { runValidation: _runValidationModule } = require('../../bin/model_client');
const { buildAllTools, buildChatRequestBody: _buildChatRequestBody } = require('../api/request_builder');

function showMiniDiff(tui, filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

async function executeTool(name, args, options = {}) {
  const {
    _fullscreenRef,
    mcpCall,
    memoryStore,
    pluginLoader,
    mcpClient,
    flags,
    config,
    tui,
    currentTaskType,
    _ledgerRunId,
    activeAgent
  } = options;

  let dedup = null;
  try {
    const { getDedup, ToolDedup } = require('../tools/dedup');
    dedup = getDedup();
    const cached = dedup.lookup(name, args);
    if (cached) return ToolDedup.markCached(cached);
  } catch {}

  let writeSet = null;
  try {
    const { getIdempotentWriteSet } = require('../tools/dedup');
    writeSet = getIdempotentWriteSet();
    if (writeSet.has(name, args)) {
      return writeSet.shortCircuitResult(name);
    }
  } catch {}

  const result = await _executeToolModule(name, args, {
    _fullscreenRef,
    mcpCall,
    memoryStore,
    pluginLoader,
    mcpClient: typeof mcpClient !== 'undefined' ? mcpClient : null,
    flags,
    config,
    tui,
    currentTaskType,
    _ledgerRunId,
    activeAgent,
  });

  try { if (dedup) dedup.record(name, args, result); } catch {}
  try { if (writeSet) writeSet.record(name, args, result); } catch {}
  return result;
}

function getAllTools(config, stage2Category, options = {}) {
  return buildAllTools(config, stage2Category, {
    pluginLoader: options.pluginLoader,
    mcpClient: typeof options.mcpClient !== 'undefined' ? options.mcpClient : null,
    taskType: options.taskType,
    agentContext: options.agentContext,
    planTracker: typeof options.planTracker !== 'undefined' ? options.planTracker : null,
    ...options
  });
}

function buildChatRequestBody(messages, tools, config, options = {}) {
  return _buildChatRequestBody(messages, tools, config, {
    fullscreenRef: typeof options.fullscreenRef !== 'undefined' ? options.fullscreenRef : undefined,
    ...options
  });
}

function estimateMessageTokens(m) {
  let chars = 0;
  if (typeof m.content === 'string') {
    chars += m.content.length;
  } else if (m.content) {
    chars += JSON.stringify(m.content).length;
  }
  // tool_calls messages have arguments that consume tokens but aren't in .content
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += (tc.function?.name?.length || 0) + (tc.function?.arguments?.length || 0) + 20;
    }
  }
  return Math.ceil(chars / 4);
}

function estimateHistoryTokens(history) {
  return history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function runValidation(filePath) {
  return _runValidationModule(filePath);
}

module.exports = {
  showMiniDiff,
  executeTool,
  getAllTools,
  buildChatRequestBody,
  estimateMessageTokens,
  estimateHistoryTokens,
  runValidation
};
