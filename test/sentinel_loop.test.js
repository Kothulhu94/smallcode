'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SentinelLoop,
  LoopDetector,
  DriftDetector,
  ProgressTracker,
  TokenBudget,
  VERDICTS,
} = require('../src/governor/sentinel_loop');

// ─────────────────────────────────────────────────────────────────────────────
// LoopDetector Tests
// ─────────────────────────────────────────────────────────────────────────────

test('LoopDetector - continue on unique or alternating tool calls', () => {
  const detector = new LoopDetector();

  // Unique call 1
  let res = detector.check({ toolCall: { name: 'read_file', argsSummary: 'a.txt' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Unique call 2
  res = detector.check({ toolCall: { name: 'read_file', argsSummary: 'b.txt' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Alternating call
  res = detector.check({ toolCall: { name: 'read_file', argsSummary: 'a.txt' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('LoopDetector - intervene after 3 identical consecutive tool calls', () => {
  const detector = new LoopDetector();

  // Call 1
  let res = detector.check({ toolCall: { name: 'patch', argsSummary: 'file.js:old->new' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Call 2
  res = detector.check({ toolCall: { name: 'patch', argsSummary: 'file.js:old->new' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Call 3 (identical name and arguments)
  res = detector.check({ toolCall: { name: 'patch', argsSummary: 'file.js:old->new' } });
  assert.equal(res.verdict, VERDICTS.INTERVENE);
  assert.equal(res.sentinel, 'LoopDetector');
  assert.match(res.message, /called 3 times consecutively/);
  assert.match(res.injection, /\[SENTINEL\]/);
});

test('LoopDetector - reset on non-tool turnState', () => {
  const detector = new LoopDetector();

  detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  
  // Non-tool call turn resets history
  detector.check({});
  
  // Should not trigger intervene on third repeat call because of break
  const res = detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('LoopDetector - reset explicitly via reset()', () => {
  const detector = new LoopDetector();

  detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  
  detector.reset();
  
  const res = detector.check({ toolCall: { name: 'patch', argsSummary: 'a' } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

// ─────────────────────────────────────────────────────────────────────────────
// DriftDetector Tests
// ─────────────────────────────────────────────────────────────────────────────

test('DriftDetector - continue if no changed files or planned files missing', () => {
  const detector = new DriftDetector();

  // Missing properties
  let res = detector.check({});
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Missing planned files
  res = detector.check({ changedFiles: ['a.txt'] });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('DriftDetector - continue if changes are all in plan', () => {
  const detector = new DriftDetector();

  const res = detector.check({
    changedFiles: ['a.txt', 'b.txt'],
    plannedFiles: ['a.txt', 'b.txt', 'c.txt'],
  });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('DriftDetector - warn on first unplanned file change', () => {
  const detector = new DriftDetector();

  const res = detector.check({
    changedFiles: ['a.txt', 'unplanned.txt'],
    plannedFiles: ['a.txt', 'b.txt'],
  });
  assert.equal(res.verdict, VERDICTS.WARN);
  assert.equal(res.sentinel, 'DriftDetector');
  assert.match(res.message, /unplanned changes/i);
});

test('DriftDetector - intervene on 3rd consecutive turn of unplanned changes', () => {
  const detector = new DriftDetector();

  const turn = {
    changedFiles: ['unplanned.txt'],
    plannedFiles: ['planned.txt'],
  };

  // Turn 1: warn
  let res = detector.check(turn);
  assert.equal(res.verdict, VERDICTS.WARN);

  // Turn 2: warn
  res = detector.check(turn);
  assert.equal(res.verdict, VERDICTS.WARN);

  // Turn 3: intervene
  res = detector.check(turn);
  assert.equal(res.verdict, VERDICTS.INTERVENE);
  assert.match(res.message, /Drifted off-plan/);
  assert.equal(res.details.consecutiveTurns, 3);
});

test('DriftDetector - reset consecutive streak on a planned/no-change turn', () => {
  const detector = new DriftDetector();

  // Turn 1: warn (unplanned)
  detector.check({ changedFiles: ['u.txt'], plannedFiles: ['p.txt'] });
  // Turn 2: warn (unplanned)
  detector.check({ changedFiles: ['u.txt'], plannedFiles: ['p.txt'] });

  // Turn 3: reset (planned changes only)
  let res = detector.check({ changedFiles: ['p.txt'], plannedFiles: ['p.txt'] });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Turn 4: should warn again (not intervene)
  res = detector.check({ changedFiles: ['u.txt'], plannedFiles: ['p.txt'] });
  assert.equal(res.verdict, VERDICTS.WARN);
});

// ─────────────────────────────────────────────────────────────────────────────
// ProgressTracker Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ProgressTracker - continue when progress is being made', () => {
  const tracker = new ProgressTracker();

  // Progress made via progressMade flag
  let res = tracker.check({ progressMade: true });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Progress made via testsPassed flag
  res = tracker.check({ testsPassed: true });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Progress made via file changes
  res = tracker.check({ changedFiles: ['a.txt'] });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('ProgressTracker - intervene after 5 consecutive turns of no progress', () => {
  const tracker = new ProgressTracker();

  const emptyTurn = {};

  // Turns 1-4: continue
  for (let i = 0; i < 4; i++) {
    const res = tracker.check(emptyTurn);
    assert.equal(res.verdict, VERDICTS.CONTINUE);
  }

  // Turn 5: intervene
  const res = tracker.check(emptyTurn);
  assert.equal(res.verdict, VERDICTS.INTERVENE);
  assert.equal(res.sentinel, 'ProgressTracker');
  assert.match(res.message, /No meaningful progress/);
});

test('ProgressTracker - reset streak on progress turn', () => {
  const tracker = new ProgressTracker();

  // 4 turns of stagnation
  for (let i = 0; i < 4; i++) {
    tracker.check({});
  }

  // Progress on turn 5
  let res = tracker.check({ progressMade: true });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Stagnation restarts, should not trigger at turn 6 (which is streak = 1)
  res = tracker.check({});
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

// ─────────────────────────────────────────────────────────────────────────────
// TokenBudget Tests
// ─────────────────────────────────────────────────────────────────────────────

test('TokenBudget - continue when well under budget', () => {
  const budget = new TokenBudget();

  // 50% usage
  let res = budget.check({ tokenUsage: { used: 5000, limit: 10000 } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // No budget properties
  res = budget.check({});
  assert.equal(res.verdict, VERDICTS.CONTINUE);

  // Safe against limit <= 0
  res = budget.check({ tokenUsage: { used: 100, limit: 0 } });
  assert.equal(res.verdict, VERDICTS.CONTINUE);
});

test('TokenBudget - warn when >= 70% budget', () => {
  const budget = new TokenBudget();

  // 70% usage
  let res = budget.check({ tokenUsage: { used: 7000, limit: 10000 } });
  assert.equal(res.verdict, VERDICTS.WARN);
  assert.equal(res.sentinel, 'TokenBudget');
  assert.match(res.message, /budget warning/i);

  // 99% usage
  res = budget.check({ tokenUsage: { used: 9900, limit: 10000 } });
  assert.equal(res.verdict, VERDICTS.WARN);
});

test('TokenBudget - halt when >= 100% budget', () => {
  const budget = new TokenBudget();

  // 100% usage
  let res = budget.check({ tokenUsage: { used: 10000, limit: 10000 } });
  assert.equal(res.verdict, VERDICTS.HALT);
  assert.equal(res.sentinel, 'TokenBudget');
  assert.match(res.message, /budget exhausted/i);

  // 110% usage
  res = budget.check({ tokenUsage: { used: 11000, limit: 10000 } });
  assert.equal(res.verdict, VERDICTS.HALT);
});

// ─────────────────────────────────────────────────────────────────────────────
// SentinelLoop Coordinator Tests
// ─────────────────────────────────────────────────────────────────────────────

test('SentinelLoop Coordinator - resolve highest severity verdict', () => {
  const loop = new SentinelLoop();

  // Turn with multiple conditions:
  // - DriftDetector: warn (unplanned changes)
  // - LoopDetector: continue
  // - ProgressTracker: continue (changed files present)
  // - TokenBudget: continue
  // Result: warn (highest severity)
  let res = loop.inspect({
    changedFiles: ['unplanned.txt'],
    plannedFiles: ['planned.txt'],
    tokenUsage: { used: 100, limit: 1000 },
  });
  assert.equal(res.verdict, VERDICTS.WARN);
  assert.equal(res.sentinel, 'DriftDetector');

  // Turn with drift (warn) AND token budget exhausted (halt)
  // Result: halt (highest severity wins)
  res = loop.inspect({
    changedFiles: ['unplanned.txt'],
    plannedFiles: ['planned.txt'],
    tokenUsage: { used: 1000, limit: 1000 },
  });
  assert.equal(res.verdict, VERDICTS.HALT);
  assert.equal(res.sentinel, 'TokenBudget');
});

test('SentinelLoop Coordinator - reset calls reset on children', () => {
  const loop = new SentinelLoop();

  // Generate 2 consecutive unplanned turns in DriftDetector (nested)
  loop.inspect({ changedFiles: ['unplanned.txt'], plannedFiles: ['planned.txt'] });
  loop.inspect({ changedFiles: ['unplanned.txt'], plannedFiles: ['planned.txt'] });

  // Reset coordinator
  loop.reset();

  // Drift turn should warn again (not intervene) since state is reset
  const res = loop.inspect({ changedFiles: ['unplanned.txt'], plannedFiles: ['planned.txt'] });
  assert.equal(res.verdict, VERDICTS.WARN);
});
