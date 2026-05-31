// SmallCode — Static Default Agent Configs and Whitelisted Tools
// Contains static mappings and definitions extracted from agent_registry.js.

'use strict';

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
    requiresApproval: true,
    thinkingEnabled: true
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
    requiresApproval: true,
    thinkingEnabled: true
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
    requiresApproval: true,
    thinkingEnabled: true
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
    requiresApproval: true,
    thinkingEnabled: true
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

module.exports = {
  KNOWN_STATIC_TOOLS,
  DEFAULT_AGENTS,
  TASK_AGENT_MAP
};
