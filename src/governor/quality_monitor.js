// SmallCode — Quality Monitor (Runtime)
// Compiled from: src/governor/quality_monitor.ms (port-mirror)
//
// Catches four model failure modes per turn and emits a targeted "steer"
// correction back into the conversation history. Capped at MAX_CORRECTIONS
// consecutive corrections to prevent a correction spiral.
//
//   1. Empty response       — no text content AND no tool calls
//   2. Empty tool name      — emitted a tool call with name === ""
//   3. Hallucinated tool    — tool name not in the known registry
//   4. Repeated tool call   — exact (name, args) identical to previous turn
//
// Inspired by little-coder's quality-monitor extension. Audited from
// https://github.com/jukefr/itsy/blob/main/docs/little-coder-analysis.md
//
// Loop-detection is already covered by EarlyStopDetector for repeats
// within a single turn; this module catches across-turn duplicates and
// the structural failures.

'use strict';

const MAX_CORRECTIONS = 2;

class QualityMonitor {
  constructor() {
    this._consecutive = 0;
    this._lastCallSignature = null; // `${name}::${argsJSON}`
  }

  reset() {
    this._consecutive = 0;
    this._lastCallSignature = null;
  }

  /**
   * Inspect a model turn and return a correction signal if any failure
   * mode fired. The caller is responsible for pushing the returned
   * { injection } string into the conversation as a user-role message
   * with the next chatCompletion call.
   *
   * @param {object} args
   * @param {object} args.message       OpenAI-shape assistant message
   * @param {Array}  args.knownTools    List of tool names currently registered
   * @param {boolean} [args.aborted]    True if the turn was deliberately aborted
   *                                   (skips quality checks — avoids spurious
   *                                   "empty response" on thinking-budget abort)
   * @returns {object|null}             { kind, injection, signature? } or null
   */
  inspect({ message, knownTools, aborted }) {
    if (aborted) return null;
    if (!message || typeof message !== 'object') return null;

    const text = typeof message.content === 'string' ? message.content.trim() : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // 1. Empty response
    if (!text && toolCalls.length === 0) {
      return this._fire({
        kind: 'empty_response',
        injection:
          '[QUALITY-MONITOR] Your previous response had no text and no tool ' +
          'calls. Continue the task — either reply to the user or invoke a ' +
          'tool. Do not return an empty turn.',
      });
    }

    // 2. Empty tool name
    for (const tc of toolCalls) {
      const name = tc && tc.function && typeof tc.function.name === 'string'
        ? tc.function.name.trim() : '';
      if (!name) {
        return this._fire({
          kind: 'empty_tool_name',
          injection:
            '[QUALITY-MONITOR] You emitted a tool call with an empty name. ' +
            'Restart the call with a real tool name. Available tools are ' +
            `listed in the system prompt (e.g. ${this._sampleTools(knownTools)}).`,
        });
      }
    }

    // 3. Hallucinated tool
    if (Array.isArray(knownTools) && knownTools.length > 0) {
      const known = new Set(knownTools);
      for (const tc of toolCalls) {
        const name = tc.function.name;
        if (!known.has(name)) {
          return this._fire({
            kind: 'hallucinated_tool',
            injection:
              `[QUALITY-MONITOR] Tool "${name}" does not exist. Pick one ` +
              `from the registered tool list. Closest matches: ` +
              `${this._closestMatches(name, knownTools)}.`,
          });
        }
      }
    }

    // 4. Repeated tool call across turns
    //    Only checks single-call turns to avoid false positives on parallel
    //    tool-call batches that legitimately share an argument set.
    if (toolCalls.length === 1) {
      const tc = toolCalls[0];
      const sig = this._signature(tc);
      if (sig && this._lastCallSignature && sig === this._lastCallSignature) {
        return this._fire({
          kind: 'repeat_call',
          signature: sig,
          injection:
            `[QUALITY-MONITOR] You are repeating the same tool call ` +
            `(${tc.function.name}) with identical arguments. The previous ` +
            'call already returned a result — read it before retrying. If ' +
            'you must retry, change the arguments first.',
        });
      }
      this._lastCallSignature = sig;
    } else if (toolCalls.length > 1) {
      // Multi-call turn — treat as a fresh signature window.
      this._lastCallSignature = null;
    }

    // Healthy turn — reset the consecutive corrections counter.
    if (this._consecutive > 0) this._consecutive = 0;
    return null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _fire(signal) {
    this._consecutive += 1;
    if (this._consecutive > MAX_CORRECTIONS) {
      // Back off — don't keep correcting, the model may be in a state we
      // can't steer out of. Return null so the agent loop can fall through
      // to its other guards (early_stop, escalation).
      return null;
    }
    return signal;
  }

  _signature(toolCall) {
    if (!toolCall || !toolCall.function) return null;
    const name = toolCall.function.name || '';
    const args = toolCall.function.arguments || '';
    return `${name}::${args}`;
  }

  _sampleTools(knownTools) {
    if (!Array.isArray(knownTools) || knownTools.length === 0) return '?';
    return knownTools.slice(0, 5).join(', ');
  }

  _closestMatches(name, knownTools) {
    if (!Array.isArray(knownTools) || knownTools.length === 0) return 'none';
    const target = String(name).toLowerCase();
    const scored = knownTools
      .map(t => ({ t, d: _editDistance(target, String(t).toLowerCase()) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(x => x.t);
    return scored.join(', ');
  }
}

// Small Levenshtein for the closest-match suggestion. We keep it local
// to avoid pulling in a fuzzy-match dependency.
function _editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

module.exports = {
  QualityMonitor,
  MAX_CORRECTIONS,
  _editDistance, // exported for tests
};
