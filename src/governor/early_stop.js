// SmallCode — Early-Stop Detection (Runtime)
// Detects degenerate model behavior: repetition loops, patch spirals, greeting regression
// Compiled from: src/governor/early_stop.ms

class EarlyStopDetector {
  constructor(config = {}) {
    this.repetitionThreshold = config.repetitionThreshold || 3;
    this.repetitionWindowChars = config.repetitionWindowChars || 200;
    this.maxPatchFailures = config.maxPatchFailures || 4;
    this.maxResponseTokens = config.maxResponseTokens || 8192;
    this.enableGreetingDetection = config.enableGreetingDetection !== false;

    this.patchFailures = {};  // filePath → consecutive failure count
  }

  /**
   * Check streaming buffer for repetition loops.
   * Call this with the accumulated output during streaming.
   * Returns a StopSignal if repetition detected, null otherwise.
   */
  checkRepetition(buffer) {
    if (buffer.length < this.repetitionWindowChars * 2) return null;

    const tail = buffer.slice(-this.repetitionWindowChars);
    for (const windowSize of [50, 80, 120]) {
      if (tail.length < windowSize * this.repetitionThreshold) continue;

      const pattern = tail.slice(0, windowSize);
      let count = 0;
      let searchFrom = 0;
      while (true) {
        const idx = tail.indexOf(pattern, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
      }

      if (count >= this.repetitionThreshold) {
        return {
          reason: 'repetition_loop',
          message: `Model repeating itself (${windowSize}-char pattern ${count}x). Stopping.`,
          action: 'inject_correction',
          injection: '[SYSTEM] You are repeating the same output in a loop. STOP. Take a different approach or state what is blocking you.',
        };
      }
    }
    return null;
  }

  /**
   * Track patch tool results. Returns a StopSignal if the model is stuck
   * in a patch spiral (repeatedly failing to match old_str on the same file).
   */
  recordPatchResult(filePath, success) {
    if (success) {
      delete this.patchFailures[filePath];
      return null;
    }

    this.patchFailures[filePath] = (this.patchFailures[filePath] || 0) + 1;
    const count = this.patchFailures[filePath];

    if (count >= this.maxPatchFailures) {
      delete this.patchFailures[filePath];
      return {
        reason: 'patch_spiral',
        message: `Patch failed ${count}x on ${filePath}. File likely corrupted. Switching to rewrite.`,
        action: 'rewrite_file',
        injection: `[SYSTEM] You have failed to patch ${filePath} ${count} times in a row. The file is corrupted from previous bad patches. STOP using patch. Instead:
1. Use read_file to see the current (broken) state
2. Decide what the file SHOULD contain
3. Use write_file to rewrite it completely from scratch
Do NOT attempt another patch on this file.`,
      };
    }
    return null;
  }

  /**
   * Detect if model output is a greeting (lost context mid-task).
   */
  checkGreeting(content, hasToolCallsThisTurn) {
    if (!this.enableGreetingDetection || !hasToolCallsThisTurn) return null;

    const lc = content.toLowerCase();
    const greetingPatterns = [
      'how can i help',
      'what would you like',
      'what can i do for you',
      'how can i assist',
      "hello! i'm ready",
      'hi there! what',
    ];

    if (!greetingPatterns.some(p => lc.includes(p))) return null;

    return {
      reason: 'greeting_regression',
      message: 'Model output a greeting mid-task (lost context).',
      action: 'inject_correction',
      injection: '[SYSTEM] You output a greeting instead of completing the task. Look at the conversation above — there is still work to do. Continue where you left off. Do NOT restart the conversation.',
    };
  }

  /**
   * Reset patch failure tracking (call at start of new user turn).
   */
  newTurn() {
    this.patchFailures = {};
  }
}

module.exports = { EarlyStopDetector };
