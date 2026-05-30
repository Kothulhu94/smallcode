const { getAllTools: _getAllToolsModule } = require('../../bin/tools');
const { getModelTarget, withModelTarget, getModelTargetForModel } = require('../../bin/config');

function buildAllTools(config, stage2Category, options = {}) {
  const { pluginLoader, mcpClient, taskType, agentContext: agentCtx, planTracker } = options;
  const tools = _getAllToolsModule(config, stage2Category, { pluginLoader, mcpClient });
  let filtered = tools;

  try {
    if (planTracker && planTracker.plan && planTracker.currentStep < planTracker.plan.length) {
      const { classifyAction, getToolsForActionType } = require('../session/action_classifier');
      const currentStepText = planTracker.plan[planTracker.currentStep];
      if (currentStepText) {
        const actionType = classifyAction(currentStepText);
        if (actionType === 'query') {
          filtered = getToolsForActionType('query', tools);
        }
      }
    }
  } catch {}

  if (agentCtx && Array.isArray(agentCtx.allowedTools)) {
    const allowedSet = new Set(agentCtx.allowedTools);
    let tempFiltered = filtered.filter(t => {
      if (!t || !t.function) return false;
      const name = t.function.name;
      if (name === 'select_category' || name.startsWith('mcp__') || name.includes(':')) return true;
      return allowedSet.has(name);
    });

    if (tempFiltered.length === 0 && filtered.length > 0 && stage2Category) {
      const fallbackTools = _getAllToolsModule(config, null, { pluginLoader, mcpClient });
      tempFiltered = fallbackTools.filter(t => {
        if (!t || !t.function) return false;
        const name = t.function.name;
        if (name === 'select_category' || name.startsWith('mcp__') || name.includes(':')) return true;
        return allowedSet.has(name);
      });
    }
    filtered = tempFiltered;
  }

  if (agentCtx && agentCtx.agentId === 'code_editor' && ['coding', 'backend', 'editing'].includes(taskType)) {
    const requiredTools = ['read_file', 'write_file', 'patch', 'read_and_patch', 'create_and_run'];
    const allowedSet = new Set(agentCtx.allowedTools);
    const fallbackTools = _getAllToolsModule(config, null, { pluginLoader, mcpClient });
    for (const toolName of requiredTools) {
      if (allowedSet.has(toolName) && !filtered.some(t => t.function && t.function.name === toolName)) {
        const toolObj = fallbackTools.find(t => t.function && t.function.name === toolName);
        if (toolObj) {
          filtered.push(toolObj);
        }
      }
    }
    
    const excludeTools = new Set(['workspace_add_task', 'workspace_add_plan']);
    filtered = filtered.filter(t => !t.function || !excludeTools.has(t.function.name));
  }

  try {
    const { getTrustDecay } = require('../tools/trust_decay');
    return getTrustDecay().filterAndSort(filtered);
  } catch {
    return filtered;
  }
}

function buildChatRequestBody(messages, tools, config, options = {}) {
  let target = options.target || config.activeModelTarget || getModelTarget(config, 'default');
  let requestConfig = withModelTarget(config, target);
  let baseUrl = options.baseUrl || target.baseUrl;
  const currentAttempt = options.currentAttempt || 0;
  const fullscreenRef = options.fullscreenRef;

  const body = {
    model: target.model,
    messages: messages,
    temperature: 0.1,
    max_tokens: parseInt(process.env.SMALLCODE_MAX_OUTPUT_TOKENS) || 4096,
  };

  let toolsDisabledReason = null;
  if (config.tools && config.tools.disabled === true) {
    toolsDisabledReason = 'Tools are explicitly disabled in config.';
  } else if (target && target.provider) {
    try {
      const { providerRegistry } = require('../compiled/providers/registry');
      if (providerRegistry.has(target.provider)) {
        const caps = providerRegistry.getCapabilities(target.provider);
        if (caps && caps.tools === false) {
          toolsDisabledReason = `Tools are not supported by provider '${target.provider}'.`;
        }
      }
    } catch {}
  }

  if (toolsDisabledReason) {
    body.__toolsDisabledReason = toolsDisabledReason;
  } else if (tools && tools.length > 0) {
    body.tools = tools;
  }

  try {
    const { getExecutorModel } = require('../model/chain');
    body.model = getExecutorModel('', config);
  } catch {}

  try {
    const { getAdaptiveRouter } = require('../model/adaptive_router');
    const router = getAdaptiveRouter();
    const selected = router.selectModel(requestConfig);
    if (selected.model && selected.model !== body.model) {
      if (typeof fullscreenRef !== 'undefined' && fullscreenRef) {
        fullscreenRef.addTool?.('adaptive', 'ok', `→ ${selected.model} (high failure rate)`);
      }
      target = {
        ...getModelTargetForModel(config, selected.model, selected.tier || target.tier),
        tier: selected.tier || target.tier,
        model: selected.model,
        name: selected.model,
        baseUrl: selected.url || target.baseUrl,
      };
      requestConfig = withModelTarget(config, target);
      baseUrl = target.baseUrl;
      body.model = target.model;
    }
  } catch {}

  try {
    const { applyThinkingBudget } = require('../model/thinking_budget');
    applyThinkingBudget(body, { baseUrl });
  } catch {}

  {
    const _bUrl = (baseUrl || '').toLowerCase();
    const _isOpenAICloud = _bUrl.includes('api.openai.com') || _bUrl.includes('openrouter.ai');
    const _modelLower = String(body.model || '').toLowerCase();
    const _isReasoning = /(^|[\/\-_])(o1|o3|o4)/.test(_modelLower);
    if (_isOpenAICloud && _isReasoning && body.max_tokens && !body.max_completion_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  }

  if (currentAttempt > 0) {
    try {
      const { applyAdaptiveTemperature } = require('../model/adaptive_temp');
      applyAdaptiveTemperature(body, currentAttempt, { isRepair: true });
    } catch {}
  }

  return { body, target, requestConfig, baseUrl };
}

module.exports = {
  buildAllTools,
  buildChatRequestBody
};
