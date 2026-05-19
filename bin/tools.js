// SmallCode — Tool Definitions
// Static tool schemas sent to the model + the getAllTools routing function.
// executeTool remains in smallcode.js due to its many cross-references.

const { getRoutingMode, getCategorySelectorTool, getToolsForCategory } = require('../src/tools/two_stage_router');

// ─── Base Tools ──────────────────────────────────────────────────────────────

const TOOLS = [
  { type: 'function', function: { name: 'list_projects', description: 'List all indexed projects/repos in the workspace with stats: file count, symbol count, lines of code, languages. Use this FIRST when asked about "the projects", "the codebase", or "what\'s in this workspace".', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'graph_search', description: 'Search the code graph for a symbol, function, or class name. Returns connected code with context. Use for "how does X work" or "find the auth logic" — NOT for listing projects.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Symbol name or concept to search for' }, max_tokens: { type: 'integer', description: 'Max tokens to return (default 4000)' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'explain_symbol', description: 'Get full explanation of a symbol: signature, location, callers, callees, and where it fits in the architecture. Use for "what does X do" questions.', parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'Symbol name to explain' } }, required: ['symbol'] } } },
  { type: 'function', function: { name: 'memory_load', description: 'Load relevant project memory for a task. Returns past decisions, workflows, conventions, and gotchas. Call this before starting complex work.', parameters: { type: 'object', properties: { task: { type: 'string', description: 'Task description to find relevant context for' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file. Returns content with line numbers.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to cwd' }, start_line: { type: 'integer', description: 'Start line (optional)' }, end_line: { type: 'integer', description: 'End line (optional)' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with content.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Full file content' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'patch', description: 'Edit a file by replacing old_str with new_str. old_str must match exactly ONE location.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to edit' }, old_str: { type: 'string', description: 'Exact text to find' }, new_str: { type: 'string', description: 'Replacement text' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command. Returns stdout/stderr.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents using regex (ripgrep). Returns matching lines.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, path: { type: 'string', description: 'Directory to search (default: .)' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'find_files', description: 'Find files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern e.g. **/*.ts' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'memory_remember', description: 'Save durable knowledge to project memory. Only save facts that should persist: decisions, workflows, gotchas, conventions. NOT task transcripts.', parameters: { type: 'object', properties: { type: { type: 'string', enum: ['decision', 'workflow', 'gotcha', 'convention', 'context'], description: 'Knowledge type' }, title: { type: 'string', description: 'Short title' }, content: { type: 'string', description: 'The knowledge' }, tags: { type: 'array', items: { type: 'string' }, description: 'Tags' } }, required: ['type', 'title', 'content'] } } },
  { type: 'function', function: { name: 'bone_compile', description: 'Compile a .bone file into a complete Node.js/TypeScript backend. Creates routes, models, auth, events, migrations, SDK, admin panel, Docker, and CI from a single declarative file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the .bone file' }, target: { type: 'string', description: 'Target: express (default), nakama, prisma, sqlite' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'bone_check', description: 'Validate a .bone file without generating code. Reports type errors and constraint violations. Use this before bone_compile to catch issues early.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the .bone file to validate' } }, required: ['path'] } } },
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
  const allTools = [...TOOLS, ...COMPOUND_TOOLS, ...pluginTools, ...mcpTools];

  const contextWindow = config?.context?.detected_window || 32768;
  const routingOverride = process.env.SMALLCODE_TOOL_ROUTING;
  const mode = getRoutingMode(contextWindow, routingOverride);

  if (mode === 'two_stage' && !stage2Category) {
    return [getCategorySelectorTool(), ...allTools];
  }

  if (mode === 'two_stage' && stage2Category) {
    return getToolsForCategory(stage2Category, allTools);
  }

  return allTools;
}

module.exports = { TOOLS, COMPOUND_TOOLS, getAllTools };
