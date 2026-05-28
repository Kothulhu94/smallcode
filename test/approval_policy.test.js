'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ApprovalPolicy, ACTIONS } = require('../src/security/approval_policy');

const TEMP_POLICY = path.join(process.cwd(), '.smallcode', 'temp_approval_policy_test.yaml');

function writeTempPolicy(yamlContent) {
  const dir = path.dirname(TEMP_POLICY);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TEMP_POLICY, yamlContent, 'utf-8');
}

function cleanupTempPolicy() {
  try {
    if (fs.existsSync(TEMP_POLICY)) {
      fs.unlinkSync(TEMP_POLICY);
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Yaml Parser & Fallback Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ApprovalPolicy - missing policy file falls back to defaults', () => {
  cleanupTempPolicy();
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  // Default policy rules should be present
  assert.ok(policy.policy.tier_0_auto.includes('cat'));
  assert.ok(policy.policy.tier_x_blocked.includes('curl'));
});

test('ApprovalPolicy - parses simple YAML lists correctly', () => {
  const testYaml = `
# Comment line
tier_0_auto:
  - "custom_cat"
  - 'custom_ls'
  - custom_echo

tier_1_session_trust:
  - custom_test

tier_2_always_ask:
  - custom_push

tier_x_blocked:
  - custom_curl
  - custom_wget
  `;

  writeTempPolicy(testYaml);
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  // Custom configurations should be loaded
  assert.deepEqual(policy.policy.tier_0_auto, ['custom_cat', 'custom_ls', 'custom_echo']);
  assert.deepEqual(policy.policy.tier_1_session_trust, ['custom_test']);
  assert.deepEqual(policy.policy.tier_2_always_ask, ['custom_push']);
  assert.deepEqual(policy.policy.tier_x_blocked, ['custom_curl', 'custom_wget']);

  cleanupTempPolicy();
});

test('ApprovalPolicy - malformed file falls back safely', () => {
  writeTempPolicy('invalid yaml structure { } [ ]');
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  // Malformed structure falls back to the default policy
  assert.ok(policy.policy.tier_0_auto.includes('cat'));
  assert.ok(policy.policy.tier_x_blocked.includes('curl'));

  cleanupTempPolicy();
});

// ─────────────────────────────────────────────────────────────────────────────
// Classification Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ApprovalPolicy - tier 0 auto-approval', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY }); // loads defaults

  const res1 = policy.classify('cat src/index.js');
  assert.equal(res1.action, ACTIONS.AUTO_APPROVE);
  assert.equal(res1.tier, '0');

  const res2 = policy.classify('git diff --stat');
  assert.equal(res2.action, ACTIONS.AUTO_APPROVE);
  assert.equal(res2.tier, '0');
});

test('ApprovalPolicy - tier X blocked', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  const res1 = policy.classify('curl -s http://unsafe.com');
  assert.equal(res1.action, ACTIONS.BLOCKED);
  assert.equal(res1.tier, 'X');

  const res2 = policy.classify('rm -rf /');
  assert.equal(res2.action, ACTIONS.BLOCKED);
  assert.equal(res2.tier, 'X');
});

test('ApprovalPolicy - tier 1 session trust flow', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  const cmd = 'npm test -- --coverage';

  // 1. Initial run needs confirmation
  let res = policy.classify(cmd);
  assert.equal(res.action, ACTIONS.ASK_ONCE);
  assert.equal(res.tier, '1');

  // 2. User approves command
  policy.approve(cmd);

  // 3. Subsequent check is auto-trusted
  res = policy.classify(cmd);
  assert.equal(res.action, ACTIONS.AUTO_TRUSTED);
  assert.equal(res.tier, '1');

  // 4. Same base command with different arguments is also trusted
  res = policy.classify('npm test --watch');
  assert.equal(res.action, ACTIONS.AUTO_TRUSTED);

  // 5. Reset clears session trust
  policy.reset();
  res = policy.classify(cmd);
  assert.equal(res.action, ACTIONS.ASK_ONCE);
});

test('ApprovalPolicy - tier 2 always-ask', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  const res1 = policy.classify('git push origin master');
  assert.equal(res1.action, ACTIONS.ALWAYS_ASK);
  assert.equal(res1.tier, '2');

  const res2 = policy.classify('npm install package-name');
  assert.equal(res2.action, ACTIONS.ALWAYS_ASK);
  assert.equal(res2.tier, '2');
});

test('ApprovalPolicy - unrecognized command defaults to Tier 2', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  const res = policy.classify('some_weird_unrecognized_tool --arg');
  assert.equal(res.action, ACTIONS.ALWAYS_ASK);
  assert.equal(res.tier, '2');
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalization Heuristics Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ApprovalPolicy - command normalization', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  assert.equal(policy.normalize('cat file.txt'), 'cat');
  assert.equal(policy.normalize('git diff -- src/index.js'), 'git diff');
  assert.equal(policy.normalize('npm test -- --watch'), 'npm test');
  assert.equal(policy.normalize('node script.js --arg=1'), 'node script.js');
  assert.equal(policy.normalize('git commit -m "initial commit"'), 'git commit');
  assert.equal(policy.normalize('  '), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Command Chaining / Operator Safety Tests
// ─────────────────────────────────────────────────────────────────────────────

test('ApprovalPolicy - chained command operator segment safety', () => {
  const policy = new ApprovalPolicy({ policyPath: TEMP_POLICY });

  // 1. Safe chained command should return ALWAYS_ASK (never auto-approve)
  const safeChained = 'npm test && cat file.js';
  const resSafe = policy.classify(safeChained);
  assert.equal(resSafe.action, ACTIONS.ALWAYS_ASK);
  assert.equal(resSafe.tier, '2');
  assert.match(resSafe.reason, /Chained commands are not permitted/);

  // 2. Chained command containing a blocked segment must return BLOCKED
  const unsafeChained = 'npm test && curl unsafe.com';
  const resUnsafe = policy.classify(unsafeChained);
  assert.equal(resUnsafe.action, ACTIONS.BLOCKED);
  assert.equal(resUnsafe.tier, 'X');
  assert.match(resUnsafe.reason, /contains a blocked segment/);

  // 3. Pipe operator safety
  const pipedCommand = 'cat file.txt | grep error';
  const resPiped = policy.classify(pipedCommand);
  assert.equal(resPiped.action, ACTIONS.ALWAYS_ASK);
});
