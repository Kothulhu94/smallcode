// SmallCode — Agent Registry & Tool Permissions
//
// Governs role-specific configurations, tool permissions, context budgets,
// memory budgets, and memory permissions for specialist agents.

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_PRESETS = new Set(['fast', 'default', 'medium', 'strong']);
const VALID_MEMORY_TYPES = new Set(['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']);

// Set of static tool names built into the harness for strict validation mode
const KNOWN_STATIC_TOOLS = new Set([
  'list_projects', 'graph_search', 'explain_symbol', 'memory_load',
  'read_file', 'write_file', 'append_file', 'patch', 'bash', 'search',
  'find_files', 'memory_remember', 'bone_compile', 'bone_check',
  'web_search', 'web_fetch', 'memory_list', 'memory_forget',
  'contract_status', 'contract_create', 'contract_assert_pass',
  'contract_assert_fail', 'contract_assert_skip',
  'read_and_patch', 'create_and_run', 'find_and_read', 'search_and_read', 'run',
  'configure_provider', 'provider_status',
  'vision_screenshot', 'vision_list', 'vision_describe', 'vision_ask',
  'workspace_create', 'workspace_list', 'workspace_set_active', 'workspace_status',
  'workspace_add_task', 'workspace_add_plan', 'workspace_add_artifact', 'workspace_link_run', 'workspace_set_root', 'workspace_diagnose'
]);

// Default agent configurations
const DEFAULT_AGENTS = {
  conductor: {
    id: 'conductor',
    name: 'Conductor',
    description: 'Task planning and orchestration agent.',
    allowedTools: [
      'list_projects', 'find_files', 'memory_load', 'memory_remember',
      'memory_list', 'memory_forget', 'contract_status', 'contract_create',
      'contract_assert_pass', 'contract_assert_fail', 'contract_assert_skip',
      'vision_screenshot', 'vision_ask',
      'workspace_create', 'workspace_list', 'workspace_set_active',
      'workspace_status', 'workspace_add_task', 'workspace_add_plan', 'workspace_link_run', 'workspace_set_root', 'workspace_diagnose'
    ],
    modelPreset: 'default',
    contextBudget: 4000,
    memoryBudget: 2000,
    memoryPermissions: {
      read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
      write: ['decision', 'context']
    },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: true
  },
  repo_navigator: {
    id: 'repo_navigator',
    name: 'Repository Navigator',
    description: 'Explores the codebase structure and indexes code symbols.',
    allowedTools: [
      'list_projects', 'find_files', 'search', 'graph_search',
      'explain_symbol', 'read_file', 'find_and_read', 'search_and_read'
    ],
    modelPreset: 'fast',
    contextBudget: 2000,
    memoryBudget: 1000,
    memoryPermissions: {
      read: ['context', 'decision', 'convention'],
      write: []
    },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: false
  },
  code_editor: {
    id: 'code_editor',
    name: 'Code Editor',
    description: 'Applies code changes, updates files, and writes scripts.',
    allowedTools: [
      'read_file', 'write_file', 'append_file', 'patch',
      'read_and_patch', 'create_and_run', 'bash',
      'workspace_status', 'workspace_add_artifact'
    ],
    modelPreset: 'default',
    contextBudget: 3000,
    memoryBudget: 1500,
    memoryPermissions: {
      read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
      write: ['gotcha']
    },
    canEditFiles: true,
    canRunShell: true,
    requiresApproval: true
  },
  qa_tester: {
    id: 'qa_tester',
    name: 'QA Tester',
    description: 'Runs unit tests and validates codebase features.',
    allowedTools: [
      'bash', 'run', 'read_file', 'contract_status',
      'contract_assert_pass', 'contract_assert_fail',
      'vision_screenshot', 'vision_ask',
      'workspace_status', 'workspace_add_artifact', 'workspace_link_run'
    ],
    modelPreset: 'fast',
    contextBudget: 2000,
    memoryBudget: 1000,
    memoryPermissions: {
      read: ['workflow', 'gotcha'],
      write: []
    },
    canEditFiles: false,
    canRunShell: true,
    requiresApproval: true
  },
  researcher: {
    id: 'researcher',
    name: 'Researcher',
    description: 'Queries external web pages and documentation.',
    allowedTools: ['web_search', 'web_fetch', 'read_file'],
    modelPreset: 'medium',
    contextBudget: 2000,
    memoryBudget: 1000,
    memoryPermissions: {
      read: ['context', 'decision'],
      write: ['context']
    },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: false
  },
  memory_curator: {
    id: 'memory_curator',
    name: 'Memory Curator',
    description: 'Manages the persistent memory store and cleans up stale items.',
    allowedTools: [
      'memory_load', 'memory_remember', 'memory_list', 'memory_forget', 'vision_list',
      'workspace_status', 'workspace_add_artifact', 'workspace_link_run'
    ],
    modelPreset: 'medium',
    contextBudget: 4000,
    memoryBudget: 2500,
    memoryPermissions: {
      read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
      write: ['decision', 'convention', 'gotcha', 'workflow', 'context']
    },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: false
  },
  architect: {
    id: 'architect',
    name: 'Architect',
    description: 'Reviews architecture, validates cross-cutting constraints, and coordinates specialist plans.',
    allowedTools: [
      'read_file', 'bone_compile', 'bone_check', 'explain_symbol', 'graph_search',
      'vision_screenshot', 'vision_ask',
      'workspace_status', 'workspace_add_plan', 'workspace_add_artifact', 'workspace_link_run'
    ],
    modelPreset: 'strong',
    contextBudget: 6000,
    memoryBudget: 3000,
    memoryPermissions: {
      read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
      write: ['decision', 'convention']
    },
    canEditFiles: true,
    canRunShell: false,
    requiresApproval: true
  },
  visual_observer: {
    id: 'visual_observer',
    name: 'Visual Observer',
    description: 'Specialist in inspecting screenshots, UI state, layout changes, and visual assets.',
    allowedTools: [
      'vision_screenshot', 'vision_describe', 'vision_ask', 'vision_list',
      'workspace_status', 'workspace_add_artifact'
    ],
    modelPreset: 'medium',
    contextBudget: 4000,
    memoryBudget: 2000,
    memoryPermissions: {
      read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
      write: ['decision', 'context']
    },
    canEditFiles: false,
    canRunShell: false,
    requiresApproval: false
  }
};

/**
 * Validate an agent definition.
 * @param {object} agent
 * @param {object} [options={}]
 * @param {boolean} [options.strictTools=false]
 */
function validateAgent(agent, options = {}) {
  if (!agent || typeof agent !== 'object') {
    throw new Error('Agent definition must be an object.');
  }

  if (typeof agent.id !== 'string' || !agent.id.trim()) {
    throw new Error('Agent id must be a non-empty string.');
  }

  if (typeof agent.name !== 'string' || !agent.name.trim()) {
    throw new Error('Agent name must be a non-empty string.');
  }

  if (!VALID_PRESETS.has(agent.modelPreset)) {
    throw new Error(`Invalid modelPreset "${agent.modelPreset}". Must be one of fast, default, medium, strong.`);
  }

  if (typeof agent.contextBudget !== 'number' || agent.contextBudget <= 0 || !Number.isInteger(agent.contextBudget)) {
    throw new Error('contextBudget must be a positive integer.');
  }

  if (typeof agent.memoryBudget !== 'number' || agent.memoryBudget <= 0 || !Number.isInteger(agent.memoryBudget)) {
    throw new Error('memoryBudget must be a positive integer.');
  }

  if (!agent.memoryPermissions || typeof agent.memoryPermissions !== 'object') {
    throw new Error('memoryPermissions must be an object containing read/write arrays.');
  }

  const { read, write } = agent.memoryPermissions;
  if (!Array.isArray(read)) {
    throw new Error('memoryPermissions.read must be an array.');
  }
  if (!Array.isArray(write)) {
    throw new Error('memoryPermissions.write must be an array.');
  }

  for (const t of read) {
    if (!VALID_MEMORY_TYPES.has(t)) {
      throw new Error(`Invalid read memory type "${t}".`);
    }
  }
  for (const t of write) {
    if (!VALID_MEMORY_TYPES.has(t)) {
      throw new Error(`Invalid write memory type "${t}".`);
    }
  }

  if (!Array.isArray(agent.allowedTools)) {
    throw new Error('allowedTools must be an array of strings.');
  }

  for (const tool of agent.allowedTools) {
    if (typeof tool !== 'string' || !tool.trim()) {
      throw new Error('Tool names in allowedTools must be non-empty strings.');
    }
    if (options.strictTools) {
      // In strict tools mode, reject unknown tools unless they are dynamic/MCP formatted
      const isMcp = tool.startsWith('mcp__') || tool.includes(':');
      if (!isMcp && !KNOWN_STATIC_TOOLS.has(tool)) {
        throw new Error(`Unknown tool name "${tool}" in strict validation mode.`);
      }
    }
  }

  if (typeof agent.canEditFiles !== 'boolean') {
    throw new Error('canEditFiles must be a boolean.');
  }
  if (typeof agent.canRunShell !== 'boolean') {
    throw new Error('canRunShell must be a boolean.');
  }
  if (typeof agent.requiresApproval !== 'boolean') {
    throw new Error('requiresApproval must be a boolean.');
  }

  return true;
}

class AgentRegistry {
  constructor(options = {}) {
    this.options = {
      configDir: options.configDir || process.cwd(),
      strictTools: !!options.strictTools,
    };
    this.agents = new Map();
    this.loadDefaults();
    this.loadLocalOverrides();
  }

  loadDefaults() {
    for (const [id, def] of Object.entries(DEFAULT_AGENTS)) {
      // Default definitions are pre-validated, but deep clone to avoid mutation
      this.agents.set(id, JSON.parse(JSON.stringify(def)));
    }
  }

  loadLocalOverrides() {
    const overridePath = path.join(this.options.configDir, '.smallcode', 'agents.json');
    if (!fs.existsSync(overridePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          this.applyOverride(item.id, item);
        }
      } else if (data && typeof data === 'object') {
        for (const [id, item] of Object.entries(data)) {
          const overrideItem = { ...item, id: item.id || id };
          this.applyOverride(overrideItem.id, overrideItem);
        }
      }
    } catch (e) {
      if (this.options.strictTools) {
        throw e; // Proactively fail on invalid overrides in strict mode
      }
      console.warn(`[AgentRegistry] Warning: failed to load local overrides: ${e.message}`);
    }
  }

  applyOverride(id, overrideData) {
    if (!id || typeof id !== 'string') return;
    const existing = this.agents.get(id);

    let merged;
    if (existing) {
      // Deep merge permissions
      const memPerms = {
        read: overrideData.memoryPermissions?.read || existing.memoryPermissions.read,
        write: overrideData.memoryPermissions?.write || existing.memoryPermissions.write,
      };
      merged = {
        ...existing,
        ...overrideData,
        memoryPermissions: memPerms
      };
    } else {
      merged = overrideData;
    }

    try {
      validateAgent(merged, { strictTools: this.options.strictTools });
      this.agents.set(id, merged);
    } catch (e) {
      if (this.options.strictTools) {
        throw e;
      }
      console.warn(`[AgentRegistry] Warning: Override for agent '${id}' failed validation: ${e.message}`);
    }
  }

  getAgent(id) {
    return this.agents.get(id) || null;
  }

  listAgents() {
    return Array.from(this.agents.values());
  }

  getAllowedTools(agentId) {
    const agent = this.getAgent(agentId);
    return agent ? agent.allowedTools : [];
  }

  getMemoryPolicy(agentId) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      return {
        contextBudget: 800,
        memoryBudget: 800,
        read: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source'],
        write: ['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']
      };
    }
    return {
      contextBudget: agent.contextBudget,
      memoryBudget: agent.memoryBudget,
      read: agent.memoryPermissions.read,
      write: agent.memoryPermissions.write,
    };
  }

  getModelPreset(agentId) {
    const agent = this.getAgent(agentId);
    return agent ? agent.modelPreset : 'default';
  }
}

function createAgentRegistry(options = {}) {
  return new AgentRegistry(options);
}

const defaultRegistry = createAgentRegistry();


// Mapping of taskType -> default agentId
const TASK_AGENT_MAP = {
  backend: 'code_editor',
  coding: 'code_editor',
  editing: 'code_editor',
  debugging: 'qa_tester',
  shell: 'qa_tester',
  search: 'repo_navigator',
  explanation: 'repo_navigator',
  multi_step: 'conductor',
  architecture: 'architect',
  design: 'architect'
};

/**
 * Resolves the appropriate agent object for a given task type.
 * Falls back to conductor if taskType is unrecognized or omitted.
 * @param {string} taskType
 * @returns {object}
 */
function resolveAgentForTask(taskType) {
  const agentId = TASK_AGENT_MAP[taskType] || 'conductor';
  return defaultRegistry.getAgent(agentId);
}

/**
 * Returns a comprehensive context object for the active agent resolved from taskType.
 * @param {string} taskType
 * @returns {object|null}
 */
function getActiveAgentContext(taskType) {
  const agent = resolveAgentForTask(taskType);
  if (!agent) return null;
  return {
    agentId: agent.id,
    name: agent.name,
    description: agent.description,
    agent: agent,
    allowedTools: agent.allowedTools,
    modelPreset: agent.modelPreset,
    contextBudget: agent.contextBudget,
    memoryBudget: agent.memoryBudget,
    memoryPermissions: agent.memoryPermissions,
    canEditFiles: agent.canEditFiles,
    canRunShell: agent.canRunShell,
    requiresApproval: agent.requiresApproval
  };
}

/**
 * Classifies a tool by its side-effects.
 * @param {string} toolName
 * @returns {object} { isFileWrite: boolean, isShell: boolean }
 */
function classifyTool(toolName) {
  const cleanName = toolName.replace(/^smallcode_/, '');
  const fileWriteTools = new Set(['write_file', 'append_file', 'patch', 'read_and_patch', 'create_and_run', 'bone_compile']);
  const shellTools = new Set(['bash', 'run', 'create_and_run']);

  return {
    isFileWrite: fileWriteTools.has(cleanName),
    isShell: shellTools.has(cleanName)
  };
}

/**
 * Authorizes a tool for execution under the active agent resolved from taskType.
 * Supports off, warn, and strict modes.
 * @param {string} toolName
 * @param {string|object} taskTypeOrCtx
 * @param {object} [options={}]
 * @returns {object} { authorized: boolean, reason: string, warning: string }
 */
function authorizeToolForAgent(toolName, taskTypeOrCtx, options = {}) {
  const mode = options.mode || process.env.SMALLCODE_ENFORCEMENT_MODE || 'warn';
  if (mode === 'off') {
    return { authorized: true };
  }

  const agentCtx = (taskTypeOrCtx && typeof taskTypeOrCtx === 'object')
    ? taskTypeOrCtx
    : getActiveAgentContext(taskTypeOrCtx);

  if (!agentCtx) {
    return { authorized: true };
  }

  const cleanName = toolName.replace(/^smallcode_/, '');
  const classification = classifyTool(toolName);

  // 1. File Writing Checks
  if (classification.isFileWrite && !agentCtx.canEditFiles) {
    const msg = `File modifications are not authorized for agent '${agentCtx.agentId}'.`;
    if (mode === 'strict') {
      return { authorized: false, reason: `Tool execution denied: ${msg}` };
    }
    return { authorized: true, warning: `[AgentRegistry Warning] ${msg}` };
  }

  // 2. Allowed Tools Whitelist
  // MCP dynamic tools starting with mcp__ or containing a colon are exempted unless strict mode requires absolute checking
  const isDynamicMcp = cleanName.startsWith('mcp__') || cleanName.includes(':');
  const isWhitelisted = agentCtx.allowedTools.includes(cleanName);

  if (!isWhitelisted && !isDynamicMcp) {
    const msg = `Tool '${toolName}' is not whitelisted for agent '${agentCtx.agentId}'.`;
    if (mode === 'strict') {
      return { authorized: false, reason: `Tool execution denied: ${msg}` };
    }
    return { authorized: true, warning: `[AgentRegistry Warning] ${msg}` };
  }

  // 3. Shell Execution Checks
  if (classification.isShell && !agentCtx.canRunShell) {
    const msg = `Shell execution is not authorized for agent '${agentCtx.agentId}'.`;
    if (mode === 'strict') {
      return { authorized: false, reason: `Tool execution denied: ${msg}` };
    }
    return { authorized: true, warning: `[AgentRegistry Warning] ${msg}` };
  }

  return { authorized: true };
}

module.exports = {
  DEFAULT_AGENTS,
  validateAgent,
  createAgentRegistry,
  getAgent: (id) => defaultRegistry.getAgent(id),
  listAgents: () => defaultRegistry.listAgents(),
  getAllowedTools: (id) => defaultRegistry.getAllowedTools(id),
  getMemoryPolicy: (id) => defaultRegistry.getMemoryPolicy(id),
  getModelPreset: (id) => defaultRegistry.getModelPreset(id),
  resolveAgentForTask,
  getActiveAgentContext,
  classifyTool,
  authorizeToolForAgent,
};
