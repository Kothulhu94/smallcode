// SmallCode — Verification Loop & Failure Classifier (Runtime)
//
// Structured post-edit retry loop that runs verification checks (syntax,
// lint, tests) and classifies results using stable error fingerprinting.
// Prevents small models from getting stuck in loops, helps identify
// regressions (restoring to baseline), and manages the retry budget.

'use strict';

const crypto = require('crypto');

const OUTCOMES = {
  PASS: 'pass',
  FIRST_FAILURE: 'first_failure',
  STUCK: 'stuck',
  PROGRESS: 'progress',
  REGRESSION: 'regression',
  FLAKY: 'flaky',
  EXHAUSTED: 'exhausted',
};

class VerificationLoop {
  /**
   * @param {object} config
   * @param {number} [config.maxRetries=3] - Maximum number of retry attempts
   * @param {Function} [config.runChecks] - Async function returning { success, errors?: Array<{ testName, message }> }
   * @param {object} [config.snapshotAdapter] - Object containing begin(), commit(), and rollback()
   * @param {Function} [config.flakyMatcher] - Function returning true if a fingerprint is flaky
   * @param {string} [config.flakyBehavior='ignore'] - How to treat flaky failures ('ignore' or 'fail')
   */
  constructor(config = {}) {
    this.maxRetries = typeof config.maxRetries === 'number' ? config.maxRetries : 3;
    this.runChecks = typeof config.runChecks === 'function' ? config.runChecks : async () => ({ success: true });
    
    this.snapshotAdapter = config.snapshotAdapter || {
      begin: () => {},
      commit: () => {},
      rollback: () => {},
    };

    this.flakyMatcher = typeof config.flakyMatcher === 'function' ? config.flakyMatcher : () => false;
    this.flakyBehavior = config.flakyBehavior || 'ignore';

    this.reset();
  }

  /**
   * Reset retry count, error history, and baseline registry.
   */
  reset() {
    this.attempt = 0;
    this.errorHistory = []; // Array of fingerprints (strings)
    this.baselinePassed = new Set(); // Set of passing test fingerprints
  }

  /**
   * Register a baseline list of passing test fingerprints.
   * If any of these fail later, it is classified as a REGRESSION.
   * @param {Array<string>} fingerprints
   */
  setBaseline(fingerprints = []) {
    this.baselinePassed = new Set(fingerprints);
  }

  /**
   * Run one iteration of the verification loop.
   *
   * @param {object} [editResult={}] - Context about files edited
   * @returns {Promise<object>} Result: { outcome, retryPrompt?, error?, message? }
   */
  async verify(editResult = {}) {
    this.attempt++;

    // Execute checks
    const checkResult = await this.runChecks(editResult);

    // 1. Check for success (PASS)
    if (checkResult.success || !checkResult.errors || checkResult.errors.length === 0) {
      this.snapshotAdapter.commit();
      return {
        outcome: OUTCOMES.PASS,
        message: 'All verification checks passed.',
      };
    }

    const currentErrors = checkResult.errors;
    const currentFingerprints = currentErrors.map(e => this.fingerprint(e));

    // 2. Filter flaky test failures
    const activeErrors = [];
    const activeFingerprints = [];
    const flakyFingerprints = [];

    for (let i = 0; i < currentFingerprints.length; i++) {
      const fp = currentFingerprints[i];
      if (this.flakyMatcher(fp)) {
        flakyFingerprints.push(fp);
      } else {
        activeFingerprints.push(fp);
        activeErrors.push(currentErrors[i]);
      }
    }

    // If all failures are flaky and we are ignoring them, treat as PASS
    if (activeFingerprints.length === 0 && this.flakyBehavior === 'ignore') {
      this.snapshotAdapter.commit();
      return {
        outcome: OUTCOMES.FLAKY,
        message: `Ignored flaky failures: ${flakyFingerprints.join(', ')}`,
        flakyFingerprints,
      };
    }

    // Pick primary error (the first non-flaky failure, or fallback to first flaky if failing flaky)
    const primaryError = activeErrors[0] || currentErrors[0];
    const primaryFp = activeFingerprints[0] || currentFingerprints[0];

    // 3. Check for retry exhaustion (EXHAUSTED)
    if (this.attempt > this.maxRetries) {
      this.snapshotAdapter.rollback();
      return {
        outcome: OUTCOMES.EXHAUSTED,
        message: `Verification failed. Retry budget of ${this.maxRetries} exhausted.`,
        error: primaryError,
        attempt: this.attempt,
        maxRetries: this.maxRetries,
      };
    }

    // 4. Classify active failure
    let outcome = OUTCOMES.FIRST_FAILURE;

    // Check for regression first
    if (this.baselinePassed.has(primaryFp)) {
      outcome = OUTCOMES.REGRESSION;
    } else if (this.errorHistory.length > 0) {
      const lastFp = this.errorHistory[this.errorHistory.length - 1];
      if (primaryFp === lastFp) {
        outcome = OUTCOMES.STUCK;
      } else {
        outcome = OUTCOMES.PROGRESS;
      }
    }

    // Record error fingerprint
    this.errorHistory.push(primaryFp);

    // Roll back if REGRESSION was detected
    if (outcome === OUTCOMES.REGRESSION) {
      this.snapshotAdapter.rollback();
    }

    const retryPrompt = this.buildRetryPrompt(outcome, primaryError);

    return {
      outcome,
      retryPrompt,
      error: primaryError,
      attempt: this.attempt,
      maxRetries: this.maxRetries,
    };
  }

  /**
   * Generate a stable SHA-256 slice hash for an error.
   *
   * @param {object} errorObj - { testName, message }
   * @returns {string} The 8-character fingerprint hash
   */
  fingerprint(errorObj) {
    if (!errorObj) return '';
    const name = typeof errorObj.testName === 'string' ? errorObj.testName.trim() : 'unknown_test';
    const rawMsg = typeof errorObj.message === 'string' ? errorObj.message : '';
    const msg = rawMsg.split('\n')[0].trim();

    return crypto
      .createHash('sha256')
      .update(`${name}::${msg}`)
      .digest('hex')
      .slice(0, 8);
  }

  /**
   * Format retry prompt instruction based on the outcome classification.
   *
   * @param {string} outcome
   * @param {object} error
   * @returns {string}
   */
  buildRetryPrompt(outcome, error) {
    const testName = error.testName || 'unknown';
    const message = error.message || 'unknown error';
    const base = `Verification failed (attempt ${this.attempt}/${this.maxRetries}):\nTest: ${testName}\nError: ${message}`;

    switch (outcome) {
      case OUTCOMES.STUCK:
        return (
          base +
          '\n\n⚠️ You are repeating the same error. Try a fundamentally different approach. ' +
          'Double check file imports, argument types, or look at how other files are structured.'
        );
      case OUTCOMES.REGRESSION:
        return (
          base +
          '\n\n⚠️ A previously passing check is now failing. Edits have been rolled back to protect baseline integrity. ' +
          'Try a safer patch or verify your assumptions.'
        );
      case OUTCOMES.PROGRESS:
        return (
          base +
          '\n\nYou fixed the previous issue but introduced a new check failure. Keep going!'
        );
      case OUTCOMES.FIRST_FAILURE:
      default:
        return base + '\n\nPlease fix this failure and verify.';
    }
  }
}

module.exports = {
  VerificationLoop,
  OUTCOMES,
};
