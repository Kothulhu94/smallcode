// SmallCode — Sentinel Loop Governor (Runtime)
//
// Extensible guardian loop that runs after each agent turn/tool call
// to detect and intervene when the model is looping, drifting, failing to
// make progress, or exceeding token budgets.
//
// Establishes four built-in sentinels:
//   1. LoopDetector     — detects 3x repeated identical tool calls
//   2. DriftDetector    — detects changes to unplanned files
//   3. ProgressTracker  — detects 5 turns of stagnation
//   4. TokenBudget      — enforces token warnings and hard halts
//
// Each sentinel accepts an abstract turnState and returns a standardized result:
//   { verdict, message, injection, sentinel, details }

'use strict';

const VERDICTS = {
  CONTINUE: 'continue',
  WARN: 'warn',
  INTERVENE: 'intervene',
  HALT: 'halt',
};

const SEVERITY = {
  [VERDICTS.CONTINUE]: 0,
  [VERDICTS.WARN]: 1,
  [VERDICTS.INTERVENE]: 2,
  [VERDICTS.HALT]: 3,
};

/**
 * LoopDetector
 * Stateful sentinel that tracks consecutive identical tool calls.
 * Triggers INTERVENE after 3 consecutive identical tool calls.
 */
class LoopDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.history = [];
  }

  check(turnState) {
    if (turnState && turnState.toolCall) {
      const { name, argsSummary } = turnState.toolCall;
      this.history.push({ name, argsSummary });

      if (this.history.length > 3) {
        this.history.shift();
      }

      if (this.history.length === 3) {
        const [first, second, third] = this.history;
        if (
          first.name === second.name &&
          second.name === third.name &&
          first.argsSummary === second.argsSummary &&
          second.argsSummary === third.argsSummary
        ) {
          return {
            verdict: VERDICTS.INTERVENE,
            message: `Tool "${name}" called 3 times consecutively with identical arguments.`,
            injection: `[SENTINEL] You are repeating the tool "${name}" with identical arguments. Read the previous tool output carefully. If you must retry, change the arguments or try a different approach.`,
            sentinel: 'LoopDetector',
            details: { name, argsSummary, history: [...this.history] },
          };
        }
      }
    } else {
      // If a turn does not have a tool call, we reset the repetition history
      this.history = [];
    }

    return {
      verdict: VERDICTS.CONTINUE,
      sentinel: 'LoopDetector',
    };
  }
}

/**
 * DriftDetector
 * Stateful sentinel that tracks modifications to files outside the plan.
 * Warns on unplanned file change, and intervenes on 3 consecutive turns of unplanned changes.
 */
class DriftDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.consecutiveUnplannedTurns = 0;
  }

  check(turnState) {
    if (!turnState || !turnState.changedFiles || !turnState.plannedFiles) {
      if (turnState && turnState.changedFiles && turnState.changedFiles.length === 0) {
        this.consecutiveUnplannedTurns = 0;
      }
      return {
        verdict: VERDICTS.CONTINUE,
        sentinel: 'DriftDetector',
      };
    }

    const { changedFiles, plannedFiles } = turnState;
    const planSet = new Set(plannedFiles);
    const unplanned = changedFiles.filter(f => !planSet.has(f));

    if (unplanned.length > 0) {
      this.consecutiveUnplannedTurns++;
      if (this.consecutiveUnplannedTurns >= 3) {
        return {
          verdict: VERDICTS.INTERVENE,
          message: `Drifted off-plan: unplanned changes to ${unplanned.join(', ')} for 3 consecutive turns.`,
          injection: `[SENTINEL] You are repeatedly modifying files outside the active plan (${unplanned.join(', ')}). Align your work with the approved plan. If the plan needs updating, update it first.`,
          sentinel: 'DriftDetector',
          details: { unplanned, consecutiveTurns: this.consecutiveUnplannedTurns },
        };
      } else {
        return {
          verdict: VERDICTS.WARN,
          message: `Unplanned changes detected in: ${unplanned.join(', ')}.`,
          injection: `[SENTINEL] You made changes to files not in the plan: ${unplanned.join(', ')}. Please keep your changes focused on the plan targets.`,
          sentinel: 'DriftDetector',
          details: { unplanned, consecutiveTurns: this.consecutiveUnplannedTurns },
        };
      }
    } else {
      this.consecutiveUnplannedTurns = 0;
    }

    return {
      verdict: VERDICTS.CONTINUE,
      sentinel: 'DriftDetector',
    };
  }
}

/**
 * ProgressTracker
 * Stateful sentinel that detects if the agent has stalled for 5 turns.
 * Progress is reset by progressMade, testsPassed, or writing files.
 */
class ProgressTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.consecutiveTurnsWithoutProgress = 0;
  }

  check(turnState) {
    if (!turnState) {
      this.consecutiveTurnsWithoutProgress++;
    } else {
      const hasProgress =
        turnState.progressMade === true ||
        turnState.testsPassed === true ||
        (Array.isArray(turnState.changedFiles) && turnState.changedFiles.length > 0);

      if (hasProgress) {
        this.consecutiveTurnsWithoutProgress = 0;
      } else {
        this.consecutiveTurnsWithoutProgress++;
      }
    }

    if (this.consecutiveTurnsWithoutProgress >= 5) {
      return {
        verdict: VERDICTS.INTERVENE,
        message: `No meaningful progress made for 5 consecutive turns.`,
        injection: `[SENTINEL] No progress (file changes, passing tests, or plan advancements) has been observed for 5 turns. Stop and re-evaluate your approach. Describe what is blocking you or try a different method.`,
        sentinel: 'ProgressTracker',
        details: { consecutiveTurns: this.consecutiveTurnsWithoutProgress },
      };
    }

    return {
      verdict: VERDICTS.CONTINUE,
      sentinel: 'ProgressTracker',
    };
  }
}

/**
 * TokenBudget
 * Stateless sentinel that checks accumulated token consumption.
 * Warns at 70% budget ratio; halts at 100%.
 */
class TokenBudget {
  reset() {
    // Stateless
  }

  check(turnState) {
    if (
      turnState &&
      turnState.tokenUsage &&
      typeof turnState.tokenUsage.used === 'number' &&
      typeof turnState.tokenUsage.limit === 'number'
    ) {
      const { used, limit } = turnState.tokenUsage;
      if (limit <= 0) {
        return { verdict: VERDICTS.CONTINUE, sentinel: 'TokenBudget' };
      }

      const ratio = used / limit;
      if (ratio >= 1.0) {
        return {
          verdict: VERDICTS.HALT,
          message: `Token budget exhausted: used ${used} of ${limit} tokens.`,
          injection: `[SENTINEL] Token budget completely exhausted (${used}/${limit}). Execution halted.`,
          sentinel: 'TokenBudget',
          details: { used, limit, ratio },
        };
      } else if (ratio >= 0.7) {
        return {
          verdict: VERDICTS.WARN,
          message: `Token budget warning: used ${used} of ${limit} tokens (${Math.round(ratio * 100)}%).`,
          injection: `[SENTINEL] You have consumed ${Math.round(ratio * 100)}% of your token budget (${used}/${limit}). Optimize your context usage.`,
          sentinel: 'TokenBudget',
          details: { used, limit, ratio },
        };
      }
    }

    return {
      verdict: VERDICTS.CONTINUE,
      sentinel: 'TokenBudget',
    };
  }
}

/**
 * SentinelLoop Coordinator
 * Manages active sentinels and resolves the highest-severity verdict.
 */
class SentinelLoop {
  constructor(config = {}) {
    this.sentinels = config.sentinels || [
      new LoopDetector(),
      new DriftDetector(),
      new ProgressTracker(),
      new TokenBudget(),
    ];
  }

  reset() {
    for (const sentinel of this.sentinels) {
      if (typeof sentinel.reset === 'function') {
        sentinel.reset();
      }
    }
  }

  /**
   * Run all active sentinels on the turnState and resolve to the highest severity result.
   *
   * @param {object} turnState
   * @returns {object} The resolved sentinel inspection result
   */
  inspect(turnState) {
    let highestResult = {
      verdict: VERDICTS.CONTINUE,
      sentinel: 'SentinelLoop',
    };
    let highestSeverity = -1;

    for (const sentinel of this.sentinels) {
      const result = sentinel.check(turnState);
      const verdict = result.verdict || VERDICTS.CONTINUE;
      const severity = SEVERITY[verdict] !== undefined ? SEVERITY[verdict] : 0;

      if (severity > highestSeverity) {
        highestSeverity = severity;
        highestResult = result;
      }
    }

    return highestResult;
  }
}

module.exports = {
  SentinelLoop,
  LoopDetector,
  DriftDetector,
  ProgressTracker,
  TokenBudget,
  VERDICTS,
  CONTINUE: VERDICTS.CONTINUE,
  WARN: VERDICTS.WARN,
  INTERVENE: VERDICTS.INTERVENE,
  HALT: VERDICTS.HALT,
};
