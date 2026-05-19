// SmallCode — Cognition Adapter
// Bridges the existing JS runtime to the MarrowScript-compiled cognition layer.
// The compiled cognition layer lives in src/compiled/ and is generated from
// marrow/smallcode_cognition.marrow.
//
// Falls back to the hand-rolled regex classifier if the compiled layer
// fails to load (e.g. tsc hasn't run, env vars not set).

let _cognitionMod = null;
let _cognitionFailed = false;

function _getCognition() {
  if (_cognitionMod) return _cognitionMod;
  if (_cognitionFailed) return null;
  try {
    _cognitionMod = require('../src/compiled/cognition');
    return _cognitionMod;
  } catch (err) {
    _cognitionFailed = true;
    return null;
  }
}

/**
 * Classify a user message into a task type using the compiled MarrowScript prompt.
 * Falls back to regex classifier if the compiled layer is unavailable.
 *
 * @param {string} userMessage - The user's input
 * @param {object} options - { fallback: function(msg) -> string }
 * @returns {Promise<string>} task type (coding | editing | search | shell | explanation | multi_step | debugging | backend)
 */
async function classifyTaskCompiled(userMessage, options = {}) {
  const cognition = _getCognition();
  if (!cognition) {
    return options.fallback ? options.fallback(userMessage) : 'coding';
  }
  try {
    const result = await cognition.callPrompt('classify_task_type', { user_message: userMessage });
    if (typeof result === 'string') {
      const cleaned = result.trim().toLowerCase().replace(/[.,!?]+$/, '');
      const valid = ['coding', 'editing', 'search', 'shell', 'explanation', 'multi_step', 'debugging', 'backend'];
      if (valid.includes(cleaned)) return cleaned;
    }
    return options.fallback ? options.fallback(userMessage) : 'coding';
  } catch (err) {
    return options.fallback ? options.fallback(userMessage) : 'coding';
  }
}

/**
 * Compress conversation history using the compiled MarrowScript prompt.
 *
 * @param {string} history - serialized history
 * @param {number} maxTokens - target compression size
 * @returns {Promise<string|null>} compressed summary or null on failure
 */
async function compressHistoryCompiled(history, maxTokens = 500) {
  const cognition = _getCognition();
  if (!cognition) return null;
  try {
    const result = await cognition.callPrompt('compress_history', { history, max_tokens: maxTokens });
    return typeof result === 'string' ? result : null;
  } catch (err) {
    return null;
  }
}

/**
 * Whether the compiled cognition layer is available.
 */
function isCompiledCognitionAvailable() {
  return _getCognition() !== null;
}

module.exports = {
  classifyTaskCompiled,
  compressHistoryCompiled,
  isCompiledCognitionAvailable,
};
