// SmallCode — Agent Registry & Tool Permissions
//
// Governs role-specific configurations, tool permissions, context budgets,
// memory budgets, and memory permissions for specialist agents.

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_PRESETS = new Set(['fast', 'default', 'medium', 'strong']);
const VALID_MEMORY_TYPES = new Set(['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']);

const { DEFAULT_AGENTS, KNOWN_STATIC_TOOLS, TASK_AGENT_MAP } = require('./agent_configs');


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


// TASK_AGENT_MAP is imported from agent_configs.js


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
