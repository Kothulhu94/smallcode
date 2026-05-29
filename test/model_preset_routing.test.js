// Milestone 9 — Model Preset Routing Unit Tests
//
// Verifies:
// 1. fast preset selects fast model target (repo_navigator/qa_tester).
// 2. default preset selects default model target (conductor/code_editor).
// 3. strong preset selects strong target (architect).
// 4. strong preset falls back to medium, default, or base model if not configured.
// 5. unknown/missing preset falls back safely.
// 6. ledger receives selected model/modelPreset.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveModelTargetForPreset,
  resolveModelTargetForAgent
} = require('../src/model/router');

const { getActiveAgentContext } = require('../src/governor/agent_registry');

const config = {
  model: { name: 'base-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
  models: {
    fast: { name: 'fast-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    default: { name: 'default-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    strong: { name: 'strong-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
  }
};

test('Milestone 9 - repo_navigator (fast preset) selects fast target', () => {
  const agentCtx = getActiveAgentContext('search'); // repo_navigator: fast preset
  assert.equal(agentCtx.modelPreset, 'fast');

  const target = resolveModelTargetForAgent(agentCtx, config);
  assert.equal(target.model, 'fast-model');
  assert.equal(target.tier, 'fast');
});

test('Milestone 9 - qa_tester (fast preset) selects fast target', () => {
  const agentCtx = getActiveAgentContext('shell'); // qa_tester: fast preset
  assert.equal(agentCtx.modelPreset, 'fast');

  const target = resolveModelTargetForAgent(agentCtx, config);
  assert.equal(target.model, 'fast-model');
  assert.equal(target.tier, 'fast');
});

test('Milestone 9 - conductor (default preset) selects default target', () => {
  const agentCtx = getActiveAgentContext('multi_step'); // conductor: default preset
  assert.equal(agentCtx.modelPreset, 'default');

  const target = resolveModelTargetForAgent(agentCtx, config);
  assert.equal(target.model, 'default-model');
  assert.equal(target.tier, 'default');
});

test('Milestone 9 - code_editor (default preset) selects default target', () => {
  const agentCtx = getActiveAgentContext('coding'); // code_editor: default preset
  assert.equal(agentCtx.modelPreset, 'default');

  const target = resolveModelTargetForAgent(agentCtx, config);
  assert.equal(target.model, 'default-model');
  assert.equal(target.tier, 'default');
});

test('Milestone 9 - architect (strong preset) selects strong target', () => {
  const agentCtx = getActiveAgentContext('architecture'); // architect: strong preset
  assert.equal(agentCtx.modelPreset, 'strong');

  const target = resolveModelTargetForAgent(agentCtx, config);
  assert.equal(target.model, 'strong-model');
  assert.equal(target.tier, 'strong');
});

test('Milestone 9 - strong falls back to medium/default/base when strong missing', () => {
  const configWithoutStrong = {
    model: { name: 'base-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    models: {
      fast: { name: 'fast-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
      default: { name: 'default-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
      medium: { name: 'medium-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    }
  };

  const agentCtx = getActiveAgentContext('architecture'); // strong preset

  // Falls back to medium first
  const target1 = resolveModelTargetForAgent(agentCtx, configWithoutStrong);
  assert.equal(target1.model, 'medium-model');
  assert.equal(target1.tier, 'medium');

  // Falls back to default next
  const configWithoutStrongOrMedium = {
    model: { name: 'base-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    models: {
      default: { name: 'default-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    }
  };
  const target2 = resolveModelTargetForAgent(agentCtx, configWithoutStrongOrMedium);
  assert.equal(target2.model, 'default-model');
  assert.equal(target2.tier, 'default');

  // Falls back to base model if default is also missing
  const configEmpty = {
    model: { name: 'base-model', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    models: {}
  };
  const target3 = resolveModelTargetForAgent(agentCtx, configEmpty);
  assert.equal(target3.model, 'base-model');
  assert.equal(target3.tier, 'default');
});

test('Milestone 9 - unknown/missing preset falls back safely', () => {
  const target = resolveModelTargetForPreset('unknown_preset', config);
  assert.equal(target.model, 'default-model');
  assert.equal(target.tier, 'default');

  const targetFallback = resolveModelTargetForPreset('unknown_preset', config, { model: 'fallback-model', tier: 'fallback' });
  assert.equal(targetFallback.model, 'fallback-model');

  const targetNullAgent = resolveModelTargetForAgent(null, config);
  assert.equal(targetNullAgent.model, 'default-model');
});

test('Milestone 9 - ledger receives selected model/modelPreset', () => {
  const { RunLedger } = require('../src/governor/run_ledger');
  const ledger = new RunLedger({ dbPath: ':memory:' });
  ledger.init();

  const agentCtx = getActiveAgentContext('coding'); // code_editor, default preset
  const target = resolveModelTargetForAgent(agentCtx, config);

  const runId = ledger.startRun({
    prompt: 'test prompt',
    model: target.model,
    taskType: 'coding',
    agentId: agentCtx.agentId,
    modelPreset: agentCtx.modelPreset
  });

  assert.ok(runId);
  const run = ledger.getRun(runId);
  assert.equal(run.model, 'default-model');
  assert.equal(run.model_preset, 'default');
  assert.equal(run.agent_id, 'code_editor');

  ledger.close();
});
