// SmallCode — Context-Aware Read Guard
// Compiled from: src/session/read_guard.ms (port-mirror)
//
// Replaces the dumb fixed-byte cap on tool results with a context-aware
// trim: when the current context is already pressured AND the tool result
// is large, we keep the first N lines (signatures + imports + module
// header) and append an explicit "use grep / read a range" directive
// rather than a silent middle-of-file truncation.
//
// Inspired by little-coder's `read-guard` extension. Audited from
// https://github.com/jukefr/itsy/blob/main/docs/little-coder-analysis.md
//
// Activated only for read-shaped tools (read_file, find_and_read,
// search_and_read, read_and_patch). Other tools fall back to the
// existing fixed cap.

'use strict';

const READ_TOOLS = new Set([
  'read_file',
  'find_and_read',
  'search_and_read',
  'read_and_patch',
]);

// Heuristic line count to keep when trimming aggressively. 30 lines is
// roughly enough for imports + the first function / class signature.
const HEAD_LINES_DEFAULT = 30;

// Token estimation — rough chars/4 heuristic. We avoid pulling in a
// real tokenizer; the goal is correctness within ~20%, not exact counts.
function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
}

// Estimate context usage (tokens) of the conversation so far. This
// mirrors what bin/smallcode.js's mid-turn eviction estimates do.
function estimateHistoryTokens(history) {
  let total = 0;
  for (const msg of history || []) {
    if (typeof msg.content === 'string') total += estTokens(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text' && part.text) total += estTokens(part.text);
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.function?.arguments) total += estTokens(tc.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Decide whether a tool result needs trimming and how. Returns a result
 * object: { trimmed: boolean, content: string, reason?: string }.
 *
 * @param {object} args
 * @param {string} args.toolName    The tool that produced this content
 * @param {string} args.content     The raw tool result string
 * @param {Array}  args.history     The current conversation history
 * @param {object} args.config      smallcode config (for context window)
 * @param {number} [args.fixedCap]  Fixed-byte fallback cap (chars)
 * @param {number} [args.headLines] Lines to keep when context-pressured
 */
function applyReadGuard({ toolName, content, history, config, fixedCap, headLines }) {
  if (typeof content !== 'string' || content.length === 0) {
    return { trimmed: false, content: content || '' };
  }

  const isRead = READ_TOOLS.has(toolName);
  const cap = Number.isFinite(fixedCap) && fixedCap > 0 ? fixedCap : 8000;
  const heads = Number.isFinite(headLines) && headLines > 0 ? headLines : HEAD_LINES_DEFAULT;

  // Quick path: result fits comfortably under the fixed cap. Pass it through.
  if (content.length <= cap) {
    return { trimmed: false, content };
  }

  // Calculate live context pressure. If we don't have a window or history,
  // fall back to the legacy fixed-byte trim with explicit signaling.
  const window = (config && config.context && Number(config.context.detected_window)) || 0;
  const budgetPct = (config && config.context && Number(config.context.max_budget_pct)) || 70;
  const fileTokens = estTokens(content);

  let usagePct = 0;
  if (window > 0) {
    const used = estimateHistoryTokens(history) + fileTokens;
    usagePct = (used / window) * 100;
  }

  // Two trigger conditions, mirroring little-coder's read-guard:
  //   1. Live context usage already past budget → aggressive trim (head only)
  //   2. File alone exceeds 50% of the window → aggressive trim
  // Otherwise, fall back to the legacy head/tail trim with a redirect hint
  // appended so the model knows what happened.
  const aggressive = !isRead
    ? false // non-read tools never get the head-only trim — they get fixed cap
    : (window > 0 && (usagePct >= budgetPct || (fileTokens * 2) >= window));

  if (aggressive) {
    const lines = content.split('\n');
    const head = lines.slice(0, heads).join('\n');
    const omitted = Math.max(0, lines.length - heads);
    const directive = [
      '',
      `... [READ-GUARD] showing first ${heads} lines (file is ${lines.length} lines, ${content.length} chars).`,
      'Context budget is tight. Do NOT re-read this file in full —',
      'use search/find_files to locate the area you need, then read a',
      'specific [start_line, end_line] range with read_file.',
      omitted > 0 ? `(${omitted} lines omitted)` : '',
    ].filter(Boolean).join('\n');
    return {
      trimmed: true,
      reason: 'context-pressure',
      content: `${head}${directive}`,
    };
  }

  // Legacy head/tail trim with explicit redirect hint. Same byte budget as
  // the prior fixed cap but with a clearer message than the silent
  // "...(truncated, N chars total)..." marker.
  const headBytes = Math.max(200, Math.floor(cap * 0.7));
  const tailBytes = Math.max(200, Math.floor(cap * 0.2));
  const head = content.slice(0, headBytes);
  const tail = content.slice(-tailBytes);
  const totalLines = (content.match(/\n/g) || []).length + 1;
  const note = isRead
    ? `\n\n...(truncated middle: ${content.length} chars / ${totalLines} lines total — re-read a smaller line range with read_file or grep first)...\n\n`
    : `\n\n...(truncated, ${content.length} chars total)...\n\n`;

  return {
    trimmed: true,
    reason: isRead ? 'fixed-cap-with-hint' : 'fixed-cap',
    content: `${head}${note}${tail}`,
  };
}

module.exports = {
  applyReadGuard,
  estimateHistoryTokens,
  estTokens,
  READ_TOOLS,
};
