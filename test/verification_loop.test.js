'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { VerificationLoop, OUTCOMES } = require('../src/governor/verification_loop');

const createMockSnapshot = () => ({
  committed: 0,
  rolledBack: 0,
  commit() {
    this.committed++;
  },
  rollback() {
    this.rolledBack++;
  },
  begin() {},
});

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint Tests
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - fingerprint stability and collision safety', () => {
  const loop = new VerificationLoop();

  const err1 = { testName: 'auth_test.js', message: 'Error: Connection failed\n  at Socket.connect' };
  const err2 = { testName: 'auth_test.js', message: 'Error: Connection failed\n  at Socket.write' };
  const err3 = { testName: 'other_test.js', message: 'Error: Connection failed' };

  const fp1 = loop.fingerprint(err1);
  const fp2 = loop.fingerprint(err2);
  const fp3 = loop.fingerprint(err3);

  // fp1 and fp2 should be identical because only the first line of the message is hashed
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 8);

  // fp3 should be different because of testName difference
  assert.notEqual(fp1, fp3);

  // Safe with missing values
  assert.equal(typeof loop.fingerprint(null), 'string');
  assert.equal(typeof loop.fingerprint({}), 'string');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass Path
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - pass path', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({ success: true }),
    snapshotAdapter: snapshot,
  });

  const res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.PASS);
  assert.equal(snapshot.committed, 1);
  assert.equal(snapshot.rolledBack, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// First Failure Path
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - first failure path', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test1.js', message: 'Error: Fail 1' }],
    }),
    snapshotAdapter: snapshot,
  });

  const res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FIRST_FAILURE);
  assert.equal(res.attempt, 1);
  assert.equal(snapshot.committed, 0);
  assert.equal(snapshot.rolledBack, 0);
  assert.match(res.retryPrompt, /Please fix this failure/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stuck / Repeated Failure
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - stuck repeated failure path', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test1.js', message: 'Error: Same error' }],
    }),
    snapshotAdapter: snapshot,
  });

  // Attempt 1: First failure
  let res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FIRST_FAILURE);

  // Attempt 2: Stuck failure
  res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.STUCK);
  assert.equal(res.attempt, 2);
  assert.equal(snapshot.committed, 0);
  assert.equal(snapshot.rolledBack, 0);
  assert.match(res.retryPrompt, /repeating the same error/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Progress / Changed Failure
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - progress changed failure path', async () => {
  let counter = 0;
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => {
      counter++;
      return {
        success: false,
        errors: [{ testName: 'test1.js', message: `Error: Fail ${counter}` }],
      };
    },
    snapshotAdapter: snapshot,
  });

  // Attempt 1: First failure (Fail 1)
  let res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FIRST_FAILURE);

  // Attempt 2: Progress (Fail 2)
  res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.PROGRESS);
  assert.equal(res.attempt, 2);
  assert.equal(snapshot.committed, 0);
  assert.equal(snapshot.rolledBack, 0);
  assert.match(res.retryPrompt, /introduced a new check failure/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression Path
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - regression path and rollback behavior', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test_baseline.js', message: 'Error: broken baseline' }],
    }),
    snapshotAdapter: snapshot,
  });

  // Register baseline error
  const fp = loop.fingerprint({ testName: 'test_baseline.js', message: 'Error: broken baseline' });
  loop.setBaseline([fp]);

  // Attempt 1: Should be immediately classified as a regression and trigger rollback
  const res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.REGRESSION);
  assert.equal(snapshot.rolledBack, 1);
  assert.equal(snapshot.committed, 0);
  assert.match(res.retryPrompt, /previously passing check is now failing/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Flaky Failure Handling
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - flaky test ignores and commits', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test_flaky.js', message: 'Error: Flaky timeout' }],
    }),
    snapshotAdapter: snapshot,
    flakyMatcher: () => true, // all tests are flaky
    flakyBehavior: 'ignore',
  });

  const res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FLAKY);
  assert.equal(snapshot.committed, 1);
  assert.equal(snapshot.rolledBack, 0);
  assert.match(res.message, /Ignored flaky failures/);
});

test('VerificationLoop - flaky test behaves normally if flakyBehavior is fail', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test_flaky.js', message: 'Error: Flaky timeout' }],
    }),
    snapshotAdapter: snapshot,
    flakyMatcher: () => true,
    flakyBehavior: 'fail',
  });

  const res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FIRST_FAILURE);
  assert.equal(snapshot.committed, 0);
  assert.equal(snapshot.rolledBack, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry Budget Exhaustion
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - retry budget exhaustion and rollback', async () => {
  const snapshot = createMockSnapshot();
  const loop = new VerificationLoop({
    maxRetries: 2,
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test1.js', message: 'Error: Stuck loop' }],
    }),
    snapshotAdapter: snapshot,
  });

  // Attempt 1: First Failure
  let res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.FIRST_FAILURE);
  assert.equal(snapshot.rolledBack, 0);

  // Attempt 2: Stuck
  res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.STUCK);
  assert.equal(snapshot.rolledBack, 0);

  // Attempt 3: Exceeded budget (limit is maxRetries = 2)
  res = await loop.verify();
  assert.equal(res.outcome, OUTCOMES.EXHAUSTED);
  assert.equal(res.attempt, 3);
  assert.equal(snapshot.rolledBack, 1);
  assert.equal(snapshot.committed, 0);
  assert.match(res.message, /Retry budget of 2 exhausted/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset Test
// ─────────────────────────────────────────────────────────────────────────────

test('VerificationLoop - coordinator reset', async () => {
  const loop = new VerificationLoop({
    runChecks: async () => ({
      success: false,
      errors: [{ testName: 'test1.js', message: 'Error: err' }],
    }),
  });

  await loop.verify();
  assert.equal(loop.attempt, 1);
  assert.equal(loop.errorHistory.length, 1);

  loop.reset();
  assert.equal(loop.attempt, 0);
  assert.equal(loop.errorHistory.length, 0);
  assert.equal(loop.baselinePassed.size, 0);
});
