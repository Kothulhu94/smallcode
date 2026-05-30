function buildDynamicContext(messages, options) {
  if (process.env.SMALLCODE_CACHE_SPLIT === 'false') return '';
  const parts = [
    getMemoryContext(messages, options),
    getSkillContext(messages, options),
    getKnowledgeContext(messages, options)
  ].filter(p => p && p.length > 0);
  if (parts.length === 0) return '';
  const raw = `<sc:context>\n${parts.join('')}\n</sc:context>\n\n`;
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function getTestRunnerContext(options) {
  try {
    if (options.testRunnerDetector) return options.testRunnerDetector.formatForPrompt();
  } catch {}
  return '';
}

function getActivePlanContext(options) {
  try {
    if (options.planTracker && options.planTracker.plan) {
      return options.planTracker.formatForPrompt();
    }
  } catch {}
  return '';
}

function getKnowledgeContext(messages, options) {
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || typeof lastUser.content !== 'string') return '';
    const loader = options.knowledgeLoader;
    if (!loader) return '';
    const maxTokens = Math.min(1500, Math.floor(((options.config?.context?.detected_window || 32768) * 0.04)));
    return loader.formatForPrompt(lastUser.content, { maxTokens });
  } catch {
    return '';
  }
}

function getMemoryContext(messages, options) {
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || !options.memoryStore?.loadForTask) return '';

    const maxTokens = Math.min(800, Math.floor(((options.config?.context?.detected_window || 32768) * 0.03)));
    const objects = options.memoryStore.loadForTask(lastUser.content, maxTokens, { 
      taskType: options.currentTaskType, 
      runId: options.currentLedgerRunId, 
      activeAgent: options.currentAgentContext 
    });
    
    const items = Array.isArray(objects) ? objects : (objects?.objects || []);
    if (items.length === 0) return '';

    let output = '\n\nRelevant project memory:\n';
    let chars = output.length;
    const maxChars = 3200;
    const { renderMemoryForContext } = require('../../bin/memory');
    for (const o of items) {
      const entry = renderMemoryForContext(o);
      if (chars + entry.length > maxChars) break;
      output += entry;
      chars += entry.length;
    }
    return output;
  } catch {
    return '';
  }
}

function getSkillContext(messages, options) {
  if (!options.skillManager) return '';
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const skills = options.skillManager.getAutoSkills(lastUser.content);
    if (skills.length === 0) return '';
    const formatted = options.skillManager.formatForPrompt(skills);
    return formatted.length > 4000
      ? formatted.slice(0, 4000) + '\n... (skills truncated to fit context)'
      : formatted;
  } catch {
    return '';
  }
}

function getPluginPrompts(options) {
  if (!options.pluginLoader) return '';
  try {
    const injection = options.pluginLoader.getPromptInjections(options.currentTaskType);
    if (!injection) return '';
    return injection.length > 2000
      ? injection.slice(0, 2000) + '\n... (plugin prompts truncated)'
      : injection;
  } catch {
    return '';
  }
}

module.exports = {
  buildDynamicContext,
  getTestRunnerContext,
  getActivePlanContext,
  getKnowledgeContext,
  getMemoryContext,
  getSkillContext,
  getPluginPrompts
};
