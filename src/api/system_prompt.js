const _contextBuilder = require('./context_builder');

function buildCompactSystemPrompt(taskType, messages, config, options = {}) {
  const {
    _bootstrapDetector,
    currentAgentContext,
  } = options;

  const cacheSplit = process.env.SMALLCODE_CACHE_SPLIT !== 'false'; // default: true
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const osHint = process.platform === 'win32' ? '\nUse "dir" not "ls", "type" not "cat". No bash-only commands.' : '';

  let bootstrapLine = '';
  try {
    if (_bootstrapDetector) {
      const raw = _bootstrapDetector.formatForPrompt();
      if (raw) bootstrapLine = raw.replace('\n\nProject:', '\n\nWorkspace context:');
    }
  } catch {}

  const { getActiveAgentContext: _getActiveAgentCtx } = require('../governor/agent_registry');
  const agentCtx = _getActiveAgentCtx(taskType) || currentAgentContext;
  let agentIdentityLine = '';
  if (agentCtx) {
    agentIdentityLine = `\n\n[ACTIVE_AGENT]\nid: ${agentCtx.agentId}\nname: ${agentCtx.name}\nrole: ${agentCtx.description}\n[/ACTIVE_AGENT]`;
  }

  let workspaceIdentityLine = '';
  try {
    const { getActiveWorkspace, loadWorkspaceManifest } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (activeId) {
      const manifest = loadWorkspaceManifest(activeId);
      workspaceIdentityLine = `\n\n[ACTIVE_WORKSPACE]\nid: ${manifest.projectId}\nname: ${manifest.name}\ngoal: ${manifest.activeGoal || 'No active goal set.'}\n[/ACTIVE_WORKSPACE]`;
    }
  } catch (e) {}

  let prompt = `You are SmallCode, a coding agent.${agentIdentityLine}${workspaceIdentityLine}\nWorking directory: ${process.cwd()}
OS: ${os}${osHint}${bootstrapLine}

Rules: Use patch for edits (not full rewrites). Prefer compound tools. Be concise. ACT immediately — do not ask for confirmation unless the task is genuinely ambiguous. If asked to read a file, read it. If asked to create something, create it. If asked about the project, read README.md or relevant files — do not answer from the workspace context line above.

CRITICAL — large file rule: write_file calls are limited to 60 lines / ~8KB. llama.cpp's JSON parser crashes on larger tool calls. For any file over 60 lines: (1) write_file with just the skeleton (imports + empty stubs), then (2) use multiple patch calls to fill in each function/section. Never put more than 60 lines in a single write_file content field.`;

  if (taskType !== 'explanation') {
    prompt += `\nUse graph_search/explain_symbol for "how does X work" questions. Use list_projects for workspace overview.`;
  }

  if (taskType === 'backend') {
    prompt += `\n\nFor Node.js backends: write a .bone file → bone_check → bone_compile. Don't hand-write routes.`;
  }

  if (cacheSplit) {
    prompt += getPluginPrompts(options) + getActivePlanContext(options) + getTestRunnerContext(options);
    if (config && config.activeEscalationSummary) {
      prompt += '\n\n' + config.activeEscalationSummary;
    }
    if (config && config.activeHandoffPrompt) {
      prompt += '\n\n' + config.activeHandoffPrompt;
    }
    return prompt;
  }

  prompt += getMemoryContext(messages, options) + getSkillContext(messages, options) + getPluginPrompts(options) + getKnowledgeContext(messages, options) + getActivePlanContext(options) + getTestRunnerContext(options);

  if (config && config.activeEscalationSummary) {
    prompt += '\n\n' + config.activeEscalationSummary;
  }
  if (config && config.activeHandoffPrompt) {
    prompt += '\n\n' + config.activeHandoffPrompt;
  }

  return prompt;
}

function buildDynamicContext(messages, options) {
  return _contextBuilder.buildDynamicContext(messages, options);
}

function getTestRunnerContext(options) {
  return _contextBuilder.getTestRunnerContext(options);
}

function getActivePlanContext(options) {
  return _contextBuilder.getActivePlanContext(options);
}

function getKnowledgeContext(messages, options) {
  return _contextBuilder.getKnowledgeContext(messages, options);
}

function getMemoryContext(messages, options) {
  return _contextBuilder.getMemoryContext(messages, options);
}

function getSkillContext(messages, options) {
  return _contextBuilder.getSkillContext(messages, options);
}

function getPluginPrompts(options) {
  return _contextBuilder.getPluginPrompts(options);
}

module.exports = {
  buildCompactSystemPrompt,
  buildDynamicContext,
  getTestRunnerContext,
  getActivePlanContext,
  getKnowledgeContext,
  getMemoryContext,
  getSkillContext,
  getPluginPrompts
};
