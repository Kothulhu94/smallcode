// SmallCode — Multi-Model Router
// Auto-picks model based on task complexity when multiple models are configured
//
// Config in smallcode.toml:
// [models]
// fast = "gemma-4-e4b"          # simple tasks (single file, small edits)
// default = "qwen3-8b"          # most tasks
// strong = "qwen3-14b"          # complex tasks (multi-file, architecture)
// escalation = "claude-sonnet-4-5"  # cloud fallback

/**
 * Estimate task complexity from the user message.
 * Returns: "fast" | "default" | "strong"
 */
function estimateComplexity(message) {
  const msg = message.toLowerCase();
  const len = msg.length;

  // Strong indicators (complex tasks)
  const strongPatterns = [
    /\b(refactor|redesign|architect|rewrite|migrate|convert)\b/,
    /\b(multi.?file|multiple files|across files|all files)\b/,
    /\b(system|framework|infrastructure|full.?stack)\b/,
    /\b(test suite|integration test|e2e)\b/,
    /\b(and then|step \d|first.*then.*finally)\b/,
  ];
  if (strongPatterns.some(p => p.test(msg)) || len > 500) {
    return 'strong';
  }

  // Fast indicators (simple tasks)
  const fastPatterns = [
    /\b(fix typo|rename|add comment|format|lint)\b/,
    /\b(what is|explain|show me|read)\b/,
    /\b(simple|quick|small|minor)\b/,
  ];
  if (fastPatterns.some(p => p.test(msg)) && len < 100) {
    return 'fast';
  }

  return 'default';
}

function routeTier(message) {
  return estimateComplexity(message);
}

/**
 * Pick the model name based on configured tiers and estimated complexity.
 */
function routeModel(message, config) {
  const models = config.models;
  if (!models) {
    // No multi-model config — use the single configured model
    return config.model.name;
  }

  const complexity = routeTier(message);

  switch (complexity) {
    case 'fast': return (models.fast?.name || models.fast) || (models.default?.name || models.default) || config.model.name;
    case 'strong': return (models.strong?.name || models.strong) || (models.default?.name || models.default) || config.model.name;
    default: return (models.default?.name || models.default) || config.model.name;
  }
}

module.exports = { estimateComplexity, routeTier, routeModel };
