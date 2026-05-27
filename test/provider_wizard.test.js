'use strict';

// SmallCode — Provider Wizard tests
// Pins the parseEnvFile / mergeEnvFile / formatStatus behaviour of PR #29.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnvFile, PROVIDERS, formatStatus } = require('../bin/provider-wizard/status');
const { mergeEnvFile } = require('../bin/provider-wizard/wizard');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('PROVIDERS registry has the expected providers', () => {
  for (const id of ['lmstudio', 'ollama', 'openrouter', 'openai', 'anthropic', 'deepseek', 'custom']) {
    assert.ok(PROVIDERS[id], `provider "${id}" should exist`);
    assert.ok(PROVIDERS[id].name);
  }
});

test('parseEnvFile returns {} for missing file', () => {
  assert.deepEqual(parseEnvFile(path.join(tmp('sc-pw'), 'absent.env')), {});
});

test('parseEnvFile parses simple key=value pairs', () => {
  const dir = tmp('sc-pw');
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'A=1\nB=two\n# comment\nC = three\n');
  const got = parseEnvFile(f);
  assert.equal(got.A, '1');
  assert.equal(got.B, 'two');
  assert.equal(got.C, 'three');
});

test('parseEnvFile strips matching surrounding quotes', () => {
  const dir = tmp('sc-pw');
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, "K1=\"quoted\"\nK2='single'\nK3=\"unbalanced'\n");
  const got = parseEnvFile(f);
  assert.equal(got.K1, 'quoted');
  assert.equal(got.K2, 'single');
  // Unbalanced quotes left as-is
  assert.equal(got.K3, '"unbalanced\'');
});

test('mergeEnvFile updates existing keys in place', () => {
  const dir = tmp('sc-pw');
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, '# header\nFOO=old\nBAR=keep\n');
  const out = mergeEnvFile(f, { FOO: 'new' });
  assert.match(out, /^# header$/m);
  assert.match(out, /^FOO=new$/m);
  assert.doesNotMatch(out, /^FOO=old$/m);
  assert.match(out, /^BAR=keep$/m);
});

test('mergeEnvFile appends new keys with a section comment', () => {
  const dir = tmp('sc-pw');
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'FOO=1\n');
  const out = mergeEnvFile(f, { NEW: 'yes' });
  assert.match(out, /Provider configuration \(added by/);
  assert.match(out, /^NEW=yes$/m);
  assert.match(out, /^FOO=1$/m);
});

test('mergeEnvFile creates content from scratch when file missing', () => {
  const dir = tmp('sc-pw');
  const f = path.join(dir, '.env-not-yet');
  // not yet written
  const out = mergeEnvFile(f, { NEW: 'yes' });
  assert.match(out, /^NEW=yes$/m);
});

test('formatStatus renders provider, base url, model, escalation', () => {
  const out = formatStatus({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hasValidKey: true,
    apiKeys: { openai: 'sk-abc', anthropic: null },
    escalation: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    envFileExists: true,
    providers: PROVIDERS,
  });
  assert.match(out, /Provider:\s+openai/);
  assert.match(out, /Base URL:\s+https:\/\/api\.openai\.com\/v1/);
  assert.match(out, /Model:\s+gpt-4o-mini/);
  assert.match(out, /API Key:\s+set/);
  assert.match(out, /Escalation:\s+anthropic \/ claude-sonnet-4-5/);
  assert.match(out, /Keys found:\s+openai=\*\*\*/);
});

test('formatStatus renders missing key + no escalation', () => {
  const out = formatStatus({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    hasValidKey: false,
    apiKeys: {},
    escalation: null,
    envFileExists: false,
    providers: PROVIDERS,
  });
  assert.match(out, /Model:\s+\(not set\)/);
  assert.match(out, /API Key:\s+missing/);
  assert.match(out, /Escalation:\s+none/);
  assert.match(out, /no \.env file/);
});
