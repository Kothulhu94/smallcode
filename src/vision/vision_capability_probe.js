// SmallCode — Vision Capability Probe
// Determines if the active model target supports multimodal vision input.

const { modelSupportsVision } = require('../session/images');

/**
 * Probes the active model/provider capability for vision support.
 * Checks configuration flags first, then falls back to model name heuristics and provider checks.
 * @param {object} config - Config object containing activeModelTarget or model info
 * @returns {{supported: boolean, confidence: 'known'|'likely'|'unknown', reason: string}}
 */
function probeVisionSupport(config) {
  const target = config?.activeModelTarget || config?.model;
  if (!target) {
    return {
      supported: false,
      confidence: 'unknown',
      reason: 'No active model target configured.'
    };
  }

  // 1. Check explicit configuration flags (highest priority)
  if (target.vision === true || target.supports_vision === true || target.supportsVision === true) {
    return {
      supported: true,
      confidence: 'known',
      reason: 'Explicitly configured in target options.'
    };
  }
  if (target.vision === false || target.supports_vision === false || target.supportsVision === false) {
    return {
      supported: false,
      confidence: 'known',
      reason: 'Explicitly disabled in target options.'
    };
  }

  const modelName = target.model || target.name || '';
  const provider = (target.provider || '').toLowerCase();

  // 2. Provider checks
  if (provider === 'anthropic') {
    // Anthropic Claude 3 / 3.5 generally supports vision
    return {
      supported: true,
      confidence: 'likely',
      reason: `Anthropic provider generally supports vision for model: ${modelName}`
    };
  }

  // 3. Model name heuristics
  if (modelSupportsVision(modelName)) {
    return {
      supported: true,
      confidence: 'likely',
      reason: `Model name "${modelName}" matches vision heuristics.`
    };
  }

  // 4. Default fallback
  return {
    supported: false,
    confidence: 'unknown',
    reason: `Provider "${provider}" and model "${modelName}" have no known vision support.`
  };
}

module.exports = {
  probeVisionSupport
};
