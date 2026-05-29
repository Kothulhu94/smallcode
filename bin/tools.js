// SmallCode — Tool Definitions
// Static tool schemas sent to the model + the getAllTools routing function.
// executeTool remains in smallcode.js due to its many cross-references.

const { getRoutingMode, getCategorySelectorTool, getToolsForCategory } = require('../src/tools/two_stage_router');

// ─── Base Tools ──────────────────────────────────────────────────────────────

const TOOLS = [
  { type: 'function', function: { name: 'list_projects', description: 'List all indexed projects/repos in the workspace with stats: file count, symbol count, lines of code, languages. Use this FIRST when asked about "the projects", "the codebase", or "what\'s in this workspace".', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'graph_search', description: 'Search the code graph for a symbol, function, or class name. Returns connected code with context. Use for "how does X work" or "find the auth logic" — NOT for listing projects.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Symbol name or concept to search for' }, max_tokens: { type: 'integer', description: 'Max tokens to return (default 4000)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'explain_symbol', description: 'Get full explanation of a symbol: signature, location, callers, callees, and where it fits in the architecture. Use for "what does X do" questions.', parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'Symbol name to explain' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'memory_load', description: 'Load relevant project memory for a task. Returns past decisions, workflows, conventions, and gotchas. Call this before starting complex work.', parameters: { type: 'object', properties: { task: { type: 'string', description: 'Task description to find relevant context for' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file. Returns content with line numbers.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to cwd' }, start_line: { type: 'integer', description: 'Start line (optional)' }, end_line: { type: 'integer', description: 'End line (optional)' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file. LIMIT: 60 lines / 8KB max. For larger files write a skeleton then use patch to add sections.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'File content — keep under 60 lines' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'append_file', description: 'Append content to the end of an existing file. Use this to build large files in chunks — write_file for the first 50 lines, then append_file for each subsequent section.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to append to' }, content: { type: 'string', description: 'Content to append — keep under 60 lines per call' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'patch', description: 'Edit a file by replacing old_str with new_str. old_str must match exactly ONE location.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to edit' }, old_str: { type: 'string', description: 'Exact text to find' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command. Returns stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents using regex (ripgrep). Returns matching lines.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, path: { type: 'string', description: 'Directory to search (default: .)' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'find_files', description: 'Find files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern e.g. **/*.ts' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'memory_remember', description: 'Save durable knowledge to project memory. Only save facts that should persist: decisions, workflows, gotchas, conventions. NOT task transcripts.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['decision', 'workflow', 'gotcha', 'convention', 'context'], description: 'Knowledge type' }, title: { type: 'string', description: 'Short title' }, content: { type: 'string', description: 'The knowledge' }, tags: { type: 'array', items: { type: 'string' }, description: 'Tags' } }, required: ['type', 'title', 'content'] } } },
  { type: 'function', function: { name: 'bone_compile', description: 'Compile a .bone file into a complete Node.js/TypeScript backend. Creates routes, models, auth, events, migrations, SDK, admin panel, Docker, and CI from a single declarative file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the .bone file' }, target: { type: 'string', description: 'Target: express (default), nakama, prisma, sqlite' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'bone_check', description: 'Validate a .bone file without generating code. Reports type errors and constraint violations. Use this before bone_compile to catch issues early.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the .bone file to validate' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the internet for information. Requires SMALLCODE_WEB_BROWSE=true.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch and extract readable text content from a URL. Requires SMALLCODE_WEB_BROWSE=true.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'memory_list', description: 'List all stored memory objects. Optionally filter by type.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'Filter by type: decision, workflow, gotcha, convention, context (optional)' } }, required: [] } } },
  { type: 'function', function: { name: 'memory_forget', description: 'Delete a memory object by ID.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Memory object ID to delete' } }, required: ['id'] } } },
  // ─── Contract tools (Definition of Done) ─────────────────────────────────
  { type: 'function', function: { name: 'contract_status', description: 'Show the active contract: assertions, their state (pending/passed/failed/skipped), and remaining blockers. Use this BEFORE claiming a task is complete.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'contract_create', description: 'Create a new Definition-of-Done contract for the current task. Pass a brief and a list of testable assertions; the agent cannot deliver "done" while any assertion remains pending. Activates the new contract automatically.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Short contract title' }, brief: { type: 'string', description: 'Free-form description of the task' }, assertions: { type: 'array', items: { type: 'string' }, description: 'List of testable assertions, one per item. Phrase each as a verifiable claim (e.g. "npm test exits 0", "POST /users returns 201 for valid input").' } }, required: ['title', 'assertions'] } } },
  { type: 'function', function: { name: 'contract_assert_pass', description: 'Mark a contract assertion as passed, with command-line evidence. Use the assertion id from contract_status (e.g. "a01"). evidence should be a short (<240 char) summary of what was run and what it returned.', parameters: { type: 'object', properties: { assertion_id: { type: 'string', description: 'Assertion id (e.g. a01)' }, evidence: { type: 'string', description: 'Short summary of command output proving the assertion holds' }, command: { type: 'string', description: 'The command run (optional)' }, exit_code: { type: 'integer', description: 'Exit code of the command (optional)' } }, required: ['assertion_id'] } } },
  { type: 'function', function: { name: 'contract_assert_fail', description: 'Mark a contract assertion as failed, with evidence. Used when a check ran and the result was wrong — not for skipping checks.', parameters: { type: 'object', properties: { assertion_id: { type: 'string', description: 'Assertion id (e.g. a01)' }, evidence: { type: 'string', description: 'Short summary of why the check failed' }, command: { type: 'string', description: 'The command run (optional)' }, exit_code: { type: 'integer', description: 'Exit code of the command (optional)' } }, required: ['assertion_id', 'evidence'] } } },
  { type: 'function', function: { name: 'contract_assert_skip', description: 'Mark an assertion as skipped (not applicable in current scope). Skipped assertions count as resolved for the done-guard.', parameters: { type: 'object', properties: { assertion_id: { type: 'string', description: 'Assertion id' }, reason: { type: 'string', description: 'Why this assertion is being skipped' } }, required: ['assertion_id', 'reason'] } } },
  { type: 'function', function: { name: 'vision_screenshot', description: 'Captures the current screen and stores it as an image artifact.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'vision_list', description: 'Lists recent image artifacts.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'vision_describe', description: 'Captures or accepts an image path and asks the active vision-capable model to describe it.', parameters: { type: 'object', properties: { image_path: { type: 'string', description: 'Path to the image file to describe. If omitted, takes a new screenshot.' } }, required: [] } } },
  { type: 'function', function: { name: 'vision_ask', description: 'Captures or accepts an image path plus a question and sends image+text to the model if supported.', parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question to ask about the image.' }, image_path: { type: 'string', description: 'Path to the image file. If omitted, takes a new screenshot.' } }, required: ['question'] } } },
  // ─── Workspace tools ───────────────────────────────────────────────────────
  { type: 'function', function: { name: 'workspace_create', description: 'Create a new project workspace and set it as active. Provide rootPath to associate a target project directory with this workspace (used by /files and file tools).', parameters: { type: 'object', properties: { projectId: { type: 'string', description: 'Raw project ID string (must not contain path traversal characters like "..", "/", "\\")' }, name: { type: 'string', description: 'Friendly project name (optional)' }, description: { type: 'string', description: 'Project description (optional)' }, goal: { type: 'string', description: 'Primary project goal (optional)' }, constraints: { type: 'array', items: { type: 'string' }, description: 'Project constraints (optional)' }, rootPath: { type: 'string', description: 'Absolute path to the target project directory on disk (optional). When set, /files and file commands operate on this directory instead of the harness root.' } }, required: ['projectId'] } } },
  { type: 'function', function: { name: 'workspace_list', description: 'List all project workspaces and their manifests.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'workspace_set_active', description: 'Set an existing project workspace as active.', parameters: { type: 'object', properties: { projectId: { type: 'string', description: 'Project ID' } }, required: ['projectId'] } } },
  { type: 'function', function: { name: 'workspace_status', description: 'Get the summary and status of the active project workspace.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'workspace_add_task', description: 'Add a new task document to the active project workspace.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, content: { type: 'string', description: 'Task checklist/markdown content' } }, required: ['title', 'content'] } } },
  { type: 'function', function: { name: 'workspace_add_plan', description: 'Add a design/implementation plan to the active project workspace.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'Plan title' }, content: { type: 'string', description: 'Plan markdown content' } }, required: ['title', 'content'] } } },
  { type: 'function', function: { name: 'workspace_add_artifact', description: 'Write a general text artifact to the active workspace.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Artifact file name' }, content: { type: 'string', description: 'Artifact content' } }, required: ['name', 'content'] } } },
  { type: 'function', function: { name: 'workspace_link_run', description: 'Link an existing ledger run ID to the active workspace.', parameters: { type: 'object', properties: { runId: { type: 'string', description: 'Ledger run ID to link' } }, required: ['runId'] } } },
  { type: 'function', function: { name: 'workspace_set_root', description: 'Set or update the target project root directory path for the active workspace. Resolves /files and file tools relative to this path.', parameters: { type: 'object', properties: { rootPath: { type: 'string', description: 'Absolute path to the target project directory on disk' }, createIfMissing: { type: 'boolean', description: 'Create the directory if it does not exist (default: false)' } }, required: ['rootPath'] } } },
  { type: 'function', function: { name: 'workspace_diagnose', description: 'Run diagnostics on current workspaces state: check active.txt, folder exists, similar/duplicate workspace names, and get recovery suggestions.', parameters: { type: 'object', properties: {}, required: [] } } }
];

// ─── Provider Tools ─────────────────────────────────────────────────────────
const PROVIDER_TOOLS = [
  { type: 'function', function: { name: 'configure_provider', description: 'Configure a provider: set provider type, base URL, model name, API key, and optional escalation fallback. Call without arguments to start the interactive wizard.', parameters: { type: 'object', properties: { provider: { type: 'string', description: 'Provider name: lmstudio, ollama, openrouter, openai, anthropic, deepseek, custom' }, baseUrl: { type: 'string', description: 'Provider base URL (e.g. http://localhost:1234/v1)' }, model: { type: 'string', description: 'Model name to use (e.g. llama-3.1-8b-instruct)' }, apiKey: { type: 'string', description: 'API key (optional, some providers require it)' }, escalationProvider: { type: 'string', description: 'Escalation fallback provider name (optional)' }, escalationModel: { type: 'string', description: 'Escalation fallback model name (optional)' } }, required: [] } } },
  { type: 'function', function: { name: 'provider_status', description: 'Show current provider configuration status: which provider is active, base URL, model, escalation settings, and whether an API key is set.', parameters: { type: 'object', properties: {}, required: [] } } },
];

// ─── Compound Tools ──────────────────────────────────────────────────────────

const COMPOUND_TOOLS = [
  { type: 'function', function: { name: 'read_and_patch', description: 'Read a file, then apply a patch to it in one step. Equivalent to read_file + patch but in a single tool call.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, old_str: { type: 'string', description: 'Text to find' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'create_and_run', description: 'Create a file and then run a command (like running the file or running tests). Equivalent to write_file + bash in one call.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to create' }, content: { type: 'string', description: 'File content' }, command: { type: 'string', description: 'Command to run after creating' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'find_and_read', description: 'Find files matching a pattern and read the first match. Equivalent to find_files + read_file in one call.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern (e.g. **/main.ts, src/**/*.py)' }, read_lines: { type: 'integer', description: 'Max lines to show from matched file. Default: 50' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'search_and_read', description: 'Search for a pattern in code, then read the most relevant file found. Equivalent to search + read_file in one call.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex to search for' }, read_context: { type: 'integer', description: 'Lines of context around matches. Default: 10' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run', description: 'Run an existing file (python, node, etc). Use this instead of create_and_run when the file already exists.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to run e.g. "python game.py" or "node server.js"' }, timeout: { type: 'integer', description: 'Timeout in seconds. Default: 30' } }, required: ['command'] } } },
];

// ─── Tool Routing ────────────────────────────────────────────────────────────

/**
 * Get the full tool list for the model, with routing awareness.
 * @param {object} config - SmallCode config
 * @param {string|null} stage2Category - If set, return only tools for that category (Stage 2)
 * @param {object} deps - { pluginLoader, mcpClient } for dynamic tools
 */
function getAllTools(config, stage2Category, deps = {}) {
  const pluginTools = deps.pluginLoader ? deps.pluginLoader.getTools() : [];
  const mcpTools = deps.mcpClient ? deps.mcpClient.getToolDefs() : [];
  const allTools = [...TOOLS, ...COMPOUND_TOOLS, ...PROVIDER_TOOLS, ...pluginTools, ...mcpTools];

  // If a deterministic tool category was pre-classified, filter tools
  // This skips the LLM-based two_stage routing entirely
  if (stage2Category) {
    try {
      const { getToolsForCategory: getCompiledTools, categoryNeedsTools } = require('../src/compiled/tool_router');
      if (!categoryNeedsTools(stage2Category)) {
        // 'respond' category — no tools needed, saves ~800 tokens
        return [];
      }
      const allowedNames = getCompiledTools(stage2Category);
      if (allowedNames && allowedNames.length > 0) {
        const filtered = allTools.filter(t => allowedNames.includes(t.function.name));
        // Always include at least read_file as fallback
        if (filtered.length > 0) return filtered;
      }
    } catch {}
    // Fall through to two_stage_router logic if compiled router fails
  }

  const contextWindow = config?.context?.detected_window || 32768;
  const routingOverride = process.env.SMALLCODE_TOOL_ROUTING;
  const mode = getRoutingMode(contextWindow, routingOverride);

  // Fix #13: On very small context models (<16k), limit tool count to save tokens.
  // Full tool schemas for 14+ tools is ~2000 tokens — 25% of an 8k context window.
  if (contextWindow <= 16384 && mode === 'two_stage' && !stage2Category) {
    // In 2-stage mode with no category yet: return ONLY the category selector.
    // Don't also append all tools (the old code did both, which is worse than either alone).
    return [getCategorySelectorTool()];
  }

  if (mode === 'two_stage' && !stage2Category) {
    // Fix #20: Don't include allTools alongside the selector. The point of 2-stage
    // is to NOT send all tools upfront. Return only the selector.
    return [getCategorySelectorTool()];
  }

  if (mode === 'two_stage' && stage2Category) {
    return getToolsForCategory(stage2Category, allTools);
  }

  return allTools;
}

// ─── Canonical Tool Schema Map ──────────────────────────────────────────────
// Single source of truth: name → schema object.
// Use this to check if a tool has a schema, or to get the schema for a tool.
// Built once at load time — O(1) lookup for filter/validation code.
const ALL_STATIC_TOOLS = [...TOOLS, ...COMPOUND_TOOLS, ...PROVIDER_TOOLS];
const TOOL_SCHEMAS_BY_NAME = new Map(
  ALL_STATIC_TOOLS.map(t => [t.function.name, t])
);

/**
 * Return an array of tool schemas filtered to only the provided tool names.
 * If allowedTools is null/undefined, returns all static schemas.
 * Dynamic tools (plugin/MCP) are not included — callers must merge separately.
 * @param {string[]|null} allowedTools
 * @returns {object[]}
 */
function getToolSchemas(allowedTools) {
  if (!allowedTools || !Array.isArray(allowedTools)) {
    return ALL_STATIC_TOOLS;
  }
  return allowedTools
    .map(name => TOOL_SCHEMAS_BY_NAME.get(name))
    .filter(Boolean);
}

module.exports = { TOOLS, COMPOUND_TOOLS, PROVIDER_TOOLS, ALL_STATIC_TOOLS, TOOL_SCHEMAS_BY_NAME, getToolSchemas, getAllTools };
