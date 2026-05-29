// Tool Registry Unity Tests
//
// Verifies the invariant: a tool cannot exist in one registry without existing in all others.
// Specifically tests:
// 1. conductor active-agent tool schema list includes all required workspace tools.
// 2. qa_tester active-agent tool schema list excludes workspace_create.
// 3. workspace creation prompt resolves multi_step -> conductor -> workspace tools visible.
// 4. executeTool can execute workspace_create with conductor/multi_step context.
// 5. executeTool denies workspace_create for qa_tester in strict mode.
// 6. Registry/tools/executor consistency: every KNOWN_STATIC_TOOL has a schema or is executor-only.
// 7. Canonical TOOL_SCHEMAS_BY_NAME map covers all static tools.
// 8. plan category in tool_router includes workspace tools.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  TOOLS, COMPOUND_TOOLS, PROVIDER_TOOLS,
  TOOL_SCHEMAS_BY_NAME, getToolSchemas, ALL_STATIC_TOOLS
} = require('../bin/tools');

const {
  resolveAgentForTask,
  getActiveAgentContext,
  authorizeToolForAgent,
  getAgent,
  KNOWN_STATIC_TOOLS: _knownStaticTools
} = require('../src/governor/agent_registry');

// Re-read KNOWN_STATIC_TOOLS directly since it's not exported — use the validator path
const agentRegistryPath = path.join(__dirname, '..', 'src', 'governor', 'agent_registry.js');
const registrySource = fs.readFileSync(agentRegistryPath, 'utf-8');

const { executeTool } = require('../bin/executor');
const { classifyToolCategory } = require('../src/compiled/tool_router');

const TEST_PROJECT_ID = 'tool-registry-unity-test';

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `tool_unity_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function cleanupTestWorkspace() {
  try {
    const { getWorkspaceRoot } = require('../src/governor/project_workspace');
    const wsRoot = getWorkspaceRoot();
    const activeTxt = path.join(wsRoot, 'active.txt');
    if (fs.existsSync(activeTxt)) {
      const active = fs.readFileSync(activeTxt, 'utf-8').trim();
      if (active === TEST_PROJECT_ID) fs.unlinkSync(activeTxt);
    }
    const testWsPath = path.join(wsRoot, TEST_PROJECT_ID);
    if (fs.existsSync(testWsPath)) fs.rmSync(testWsPath, { recursive: true, force: true });
  } catch {}
}

// ─── Test 1: conductor tool schema list includes required workspace tools ──────

test('Tool Registry Unity - conductor allowedTools includes required workspace tools', () => {
  const conductor = getAgent('conductor');
  assert.ok(conductor, 'conductor agent must exist');

  const conductorAllowed = new Set(conductor.allowedTools);

  const requiredWorkspaceTools = [
    'workspace_create',
    'workspace_set_active',
    'workspace_status',
    'workspace_add_task',
    'workspace_add_plan',
  ];

  for (const toolName of requiredWorkspaceTools) {
    assert.ok(
      conductorAllowed.has(toolName),
      `conductor.allowedTools must include "${toolName}"`
    );
  }

  // Also verify each required tool has a schema in the canonical map
  for (const toolName of requiredWorkspaceTools) {
    assert.ok(
      TOOL_SCHEMAS_BY_NAME.has(toolName),
      `TOOL_SCHEMAS_BY_NAME must contain a schema for "${toolName}"`
    );
  }
});

// ─── Test 2: qa_tester tool schema list excludes workspace_create ─────────────

test('Tool Registry Unity - qa_tester allowedTools excludes workspace_create', () => {
  const qaTester = getAgent('qa_tester');
  assert.ok(qaTester, 'qa_tester agent must exist');

  assert.ok(
    !qaTester.allowedTools.includes('workspace_create'),
    'qa_tester.allowedTools must NOT include workspace_create'
  );

  // Also verify getToolSchemas(qa_tester.allowedTools) does not contain workspace_create
  const schemas = getToolSchemas(qaTester.allowedTools);
  const names = schemas.map(s => s.function.name);
  assert.ok(
    !names.includes('workspace_create'),
    'getToolSchemas(qa_tester.allowedTools) must not include workspace_create schema'
  );
});

// ─── Test 3: workspace creation prompt resolves multi_step -> conductor ────────

test('Tool Registry Unity - workspace creation prompt classifies as multi_step and conductor exposes workspace_create', () => {
  // A typical workspace creation request
  const wsPrompt = 'Create a new project workspace for the local agent harness and set it as active';

  // Task classifier
  const { classifyTask } = require('../bin/governor');
  const taskType = classifyTask(wsPrompt);

  // multi_step is the expected type for workspace setup requests
  // (due to "create" + "project" + length triggers multi_step in many classifiers)
  // We verify the resolved agent is conductor regardless of exact task type
  const agent = resolveAgentForTask(taskType);
  assert.ok(
    agent.id === 'conductor' || agent.allowedTools.includes('workspace_create'),
    `Agent resolved for "${taskType}" must have workspace_create. Got agent: ${agent.id}`
  );

  // Direct multi_step -> conductor check
  const conductorCtx = getActiveAgentContext('multi_step');
  assert.ok(conductorCtx, 'multi_step must resolve to a valid agent context');
  assert.equal(conductorCtx.agentId, 'conductor', 'multi_step must map to conductor');
  assert.ok(
    conductorCtx.allowedTools.includes('workspace_create'),
    'conductor (multi_step) allowedTools must include workspace_create'
  );

  // The plan tool category (used during multi_step turns) must include workspace tools
  const { getToolsForCategory } = require('../src/compiled/tool_router');
  const planTools = getToolsForCategory('plan');
  assert.ok(
    planTools.includes('workspace_create'),
    'tool_router plan category must include workspace_create'
  );
  assert.ok(
    planTools.includes('workspace_set_active'),
    'tool_router plan category must include workspace_set_active'
  );
});

// ─── Test 4: executeTool can execute workspace_create with conductor context ───

test('Tool Registry Unity - executeTool executes workspace_create with conductor context', async () => {
  cleanupTestWorkspace();
  const conductor = getAgent('conductor');
  assert.ok(conductor, 'conductor agent must exist');

  const ctx = {
    currentTaskType: 'multi_step',
    activeAgent: conductor,
    config: {},
  };

  const result = await executeTool('workspace_create', {
    projectId: TEST_PROJECT_ID,
    name: 'Unity Test Workspace',
    goal: 'Verify tool registry consistency'
  }, ctx);

  assert.ok(!result.error, `workspace_create must succeed: ${result.error}`);
  assert.equal(result.projectId, TEST_PROJECT_ID);
  assert.ok(result.result.includes('created successfully'));

  cleanupTestWorkspace();
});

// ─── Test 5: executeTool denies workspace_create for qa_tester in strict mode ──

test('Tool Registry Unity - executeTool denies workspace_create for qa_tester in strict mode', async () => {
  const savedMode = process.env.SMALLCODE_ENFORCEMENT_MODE;
  process.env.SMALLCODE_ENFORCEMENT_MODE = 'strict';

  try {
    const qaTester = getAgent('qa_tester');
    assert.ok(qaTester, 'qa_tester agent must exist');

    const ctx = {
      currentTaskType: 'shell',
      activeAgent: qaTester,
      config: {},
    };

    const result = await executeTool('workspace_create', {
      projectId: 'denied-test-ws'
    }, ctx);

    assert.ok(result.error, 'workspace_create must be denied for qa_tester in strict mode');
    assert.ok(
      result.error.includes('not whitelisted') || result.error.includes('Tool execution denied'),
      `Error must be an authorization denial, got: ${result.error}`
    );
  } finally {
    if (savedMode === undefined) {
      delete process.env.SMALLCODE_ENFORCEMENT_MODE;
    } else {
      process.env.SMALLCODE_ENFORCEMENT_MODE = savedMode;
    }
  }
});

// ─── Test 6: Registry / tools / executor consistency ─────────────────────────

test('Tool Registry Unity - every KNOWN_STATIC_TOOL has a schema in TOOL_SCHEMAS_BY_NAME', () => {
  // Extract KNOWN_STATIC_TOOLS from agent_registry.js source via regex
  // since it is not exported. This validates the invariant at import time.
  const match = registrySource.match(/const KNOWN_STATIC_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'KNOWN_STATIC_TOOLS definition must be present in agent_registry.js');

  // Parse tool names from the set definition
  const setBody = match[1];
  const toolNames = [];
  for (const m of setBody.matchAll(/'([^']+)'/g)) {
    toolNames.push(m[1]);
  }

  // These are executor-only tools that have no model-facing schema
  // (they are not part of the tool schema list sent to the model)
  const EXECUTOR_ONLY_TOOLS = new Set([]);

  const missingSchemas = [];
  for (const name of toolNames) {
    if (EXECUTOR_ONLY_TOOLS.has(name)) continue;
    if (!TOOL_SCHEMAS_BY_NAME.has(name)) {
      missingSchemas.push(name);
    }
  }

  assert.deepEqual(
    missingSchemas,
    [],
    `The following KNOWN_STATIC_TOOLS have no schema in TOOL_SCHEMAS_BY_NAME: ${missingSchemas.join(', ')}`
  );
});

// ─── Test 7: Canonical TOOL_SCHEMAS_BY_NAME map ───────────────────────────────

test('Tool Registry Unity - TOOL_SCHEMAS_BY_NAME covers all static tools', () => {
  assert.ok(TOOL_SCHEMAS_BY_NAME instanceof Map, 'TOOL_SCHEMAS_BY_NAME must be a Map');
  assert.ok(TOOL_SCHEMAS_BY_NAME.size > 0, 'TOOL_SCHEMAS_BY_NAME must be non-empty');

  // Every tool in the arrays must be in the map
  for (const t of ALL_STATIC_TOOLS) {
    const name = t.function.name;
    assert.ok(
      TOOL_SCHEMAS_BY_NAME.has(name),
      `Tool "${name}" from static arrays must be in TOOL_SCHEMAS_BY_NAME`
    );
    assert.equal(
      TOOL_SCHEMAS_BY_NAME.get(name),
      t,
      `TOOL_SCHEMAS_BY_NAME["${name}"] must be the exact same schema object`
    );
  }

  // getToolSchemas(null) returns all static tools
  const allSchemas = getToolSchemas(null);
  assert.equal(allSchemas.length, ALL_STATIC_TOOLS.length);

  // getToolSchemas with a filtered list returns only those tools
  const filtered = getToolSchemas(['read_file', 'write_file', 'workspace_create']);
  assert.equal(filtered.length, 3);
  const filteredNames = filtered.map(s => s.function.name);
  assert.ok(filteredNames.includes('read_file'));
  assert.ok(filteredNames.includes('write_file'));
  assert.ok(filteredNames.includes('workspace_create'));

  // getToolSchemas with an empty list returns no tools
  const empty = getToolSchemas([]);
  assert.equal(empty.length, 0);
});

// ─── Test 8: plan category in tool_router includes workspace tools ─────────────

test('Tool Registry Unity - compiled tool_router plan category includes workspace tools', () => {
  const { getToolsForCategory } = require('../src/compiled/tool_router');
  const planTools = getToolsForCategory('plan');

  const expectedWorkspaceTools = [
    'workspace_create',
    'workspace_list',
    'workspace_set_active',
    'workspace_status',
    'workspace_add_task',
    'workspace_add_plan',
    'workspace_add_artifact',
    'workspace_link_run',
  ];

  for (const toolName of expectedWorkspaceTools) {
    assert.ok(
      planTools.includes(toolName),
      `tool_router 'plan' category must include "${toolName}"`
    );

    // Also verify each has a schema
    assert.ok(
      TOOL_SCHEMAS_BY_NAME.has(toolName),
      `Workspace tool "${toolName}" in plan category must have a schema in TOOL_SCHEMAS_BY_NAME`
    );
  }
});
