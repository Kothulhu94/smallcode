// Agent Registry + Tool Permissions Unit Tests
//
// Verifies:
// 1. All seven default agents load properly.
// 2. Schema validation rejects missing id/name/modelPreset/contextBudget/memoryPermissions.
// 3. Invalid modelPreset is rejected.
// 4. Invalid memory type is rejected.
// 5. getAgent(id) works.
// 6. getAgent(unknown) behavior is explicit.
// 7. getAllowedTools(id) works.
// 8. getMemoryPolicy(id) works.
// 9. getModelPreset(id) works.
// 10. Local override merge works (both array and object config formats).
// 11. Strict tool validation rejects unknown tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  validateAgent,
  createAgentRegistry,
  getAgent,
  listAgents,
  getAllowedTools,
  getMemoryPolicy,
  getModelPreset
} = require('../src/governor/agent_registry');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-agent-test-'));
}

function cleanupDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) cleanupDir(full);
      else fs.unlinkSync(full);
    }
    fs.rmdirSync(dir);
  } catch {}
}

test('Agent Registry - default agents load and getAgent works', () => {
  const agents = listAgents();
  assert.equal(agents.length, 8);

  const ids = agents.map(a => a.id);
  assert.ok(ids.includes('conductor'));
  assert.ok(ids.includes('repo_navigator'));
  assert.ok(ids.includes('code_editor'));
  assert.ok(ids.includes('qa_tester'));
  assert.ok(ids.includes('researcher'));
  assert.ok(ids.includes('memory_curator'));
  assert.ok(ids.includes('architect'));
  assert.ok(ids.includes('visual_observer'));

  // getAgent on global default registry
  const conductor = getAgent('conductor');
  assert.ok(conductor);
  assert.equal(conductor.id, 'conductor');
  assert.equal(conductor.name, 'Conductor');

  // getAgent on unknown returns null
  assert.equal(getAgent('ghost'), null);
});

test('Agent Registry - validation schema checks', () => {
  // Valid base agent
  const validAgent = {
    id: 'test_agent',
    name: 'Test Agent',
    description: 'A test agent',
    allowedTools: ['read_file', 'write_file'],
    modelPreset: 'fast',
    contextBudget: 1000,
    memoryBudget: 500,
    memoryPermissions: {
      read: ['decision', 'convention'],
      write: ['decision']
    },
    canEditFiles: true,
    canRunShell: false,
    requiresApproval: true
  };

  assert.ok(validateAgent(validAgent));

  // 1. Missing ID
  assert.throws(() => validateAgent({ ...validAgent, id: '' }));
  assert.throws(() => validateAgent({ ...validAgent, id: undefined }));

  // 2. Missing name
  assert.throws(() => validateAgent({ ...validAgent, name: '' }));

  // 3. Invalid modelPreset
  assert.throws(() => validateAgent({ ...validAgent, modelPreset: 'ultra' }));

  // 4. Invalid contextBudget
  assert.throws(() => validateAgent({ ...validAgent, contextBudget: -1 }));
  assert.throws(() => validateAgent({ ...validAgent, contextBudget: 1.5 }));

  // 5. Invalid memoryPermissions
  assert.throws(() => validateAgent({ ...validAgent, memoryPermissions: null }));
  assert.throws(() => validateAgent({ ...validAgent, memoryPermissions: { read: ['decision', 'fake'], write: [] } }));

  // 6. Non-boolean flags
  assert.throws(() => validateAgent({ ...validAgent, canEditFiles: 'yes' }));
});

test('Agent Registry - strict tool validation', () => {
  const agentWithBadTool = {
    id: 'test_agent',
    name: 'Test Agent',
    allowedTools: ['read_file', 'hack_mainframe'],
    modelPreset: 'fast',
    contextBudget: 1000,
    memoryBudget: 500,
    memoryPermissions: { read: [], write: [] },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: false
  };

  // Normal mode doesn't reject unknown tool strings
  assert.ok(validateAgent(agentWithBadTool, { strictTools: false }));

  // Strict mode throws error on unknown tool strings
  assert.throws(() => validateAgent(agentWithBadTool, { strictTools: true }));

  // Dynamic/MCP tools are allowed in strict mode
  const agentWithMcp = {
    ...agentWithBadTool,
    allowedTools: ['read_file', 'mcp__list_users', 'github:create_issue']
  };
  assert.ok(validateAgent(agentWithMcp, { strictTools: true }));
});

test('Agent Registry - accessor functions', () => {
  const conductorTools = getAllowedTools('conductor');
  assert.ok(conductorTools.includes('contract_create'));

  const memoryPolicy = getMemoryPolicy('conductor');
  assert.equal(memoryPolicy.contextBudget, 4000);
  assert.equal(memoryPolicy.memoryBudget, 2000);
  assert.deepEqual(memoryPolicy.read, ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']);

  // Unknown fallback policy
  const unknownPolicy = getMemoryPolicy('ghost');
  assert.equal(unknownPolicy.contextBudget, 800);
  assert.deepEqual(unknownPolicy.write, ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']);

  const preset = getModelPreset('repo_navigator');
  assert.equal(preset, 'fast');

  const unknownPreset = getModelPreset('ghost');
  assert.equal(unknownPreset, 'default');
});

test('Agent Registry - local override merging', () => {
  const tempDir = makeTempDir();
  const smallcodeDir = path.join(tempDir, '.smallcode');
  fs.mkdirSync(smallcodeDir);

  // Write override agents.json as an array
  const overrides = [
    {
      id: 'repo_navigator',
      name: 'Custom Navigator',
      allowedTools: ['list_projects', 'find_files'],
      modelPreset: 'medium',
      contextBudget: 5000,
      memoryPermissions: {
        read: ['gotcha']
      }
    },
    {
      id: 'custom_agent',
      name: 'Custom Agent',
      allowedTools: ['read_file'],
      modelPreset: 'strong',
      contextBudget: 8000,
      memoryBudget: 4000,
      memoryPermissions: { read: ['context'], write: ['context'] },
      canEditFiles: true,
      canRunShell: false,
      requiresApproval: true
    }
  ];

  fs.writeFileSync(path.join(smallcodeDir, 'agents.json'), JSON.stringify(overrides));

  const registry = createAgentRegistry({ configDir: tempDir });
  
  // Custom Navigator should be merged with default
  const mergedNav = registry.getAgent('repo_navigator');
  assert.ok(mergedNav);
  assert.equal(mergedNav.name, 'Custom Navigator'); // overridden
  assert.equal(mergedNav.modelPreset, 'medium'); // overridden
  assert.equal(mergedNav.contextBudget, 5000); // overridden
  assert.equal(mergedNav.memoryBudget, 1000); // default preserved
  assert.deepEqual(mergedNav.allowedTools, ['list_projects', 'find_files']); // overridden
  assert.deepEqual(mergedNav.memoryPermissions.read, ['gotcha']); // overridden
  assert.deepEqual(mergedNav.memoryPermissions.write, []); // default preserved
  assert.equal(mergedNav.canEditFiles, false); // default preserved

  // Custom Agent should be loaded
  const customAgent = registry.getAgent('custom_agent');
  assert.ok(customAgent);
  assert.equal(customAgent.name, 'Custom Agent');
  assert.equal(customAgent.modelPreset, 'strong');

  cleanupDir(tempDir);
});

test('Agent Registry - local override merging from object config', () => {
  const tempDir = makeTempDir();
  const smallcodeDir = path.join(tempDir, '.smallcode');
  fs.mkdirSync(smallcodeDir);

  // Write override agents.json as an object mapping
  const overrides = {
    qa_tester: {
      name: 'Custom Tester',
      modelPreset: 'strong',
      contextBudget: 4000
    }
  };

  fs.writeFileSync(path.join(smallcodeDir, 'agents.json'), JSON.stringify(overrides));

  const registry = createAgentRegistry({ configDir: tempDir });
  const qa = registry.getAgent('qa_tester');
  assert.ok(qa);
  assert.equal(qa.name, 'Custom Tester');
  assert.equal(qa.modelPreset, 'strong');
  assert.equal(qa.contextBudget, 4000);
  assert.equal(qa.canRunShell, true); // preserved default

  cleanupDir(tempDir);
});
