const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');
const { safeResolvePath, escapeShellArg, sanitizeToolOutput } = require('../security/sanitize');
const { authorizeToolForAgent } = require('../governor/agent_registry');

function runMCP(options) {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await handleMCPRequest(request, options);
      console.log(JSON.stringify(response));
    } catch (err) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }));
    }
  });
}

async function handleMCPRequest(request, options) {
  const { id, method } = request;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'smallcode', version: options.VERSION || '1.0.0' },
      }};
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [
        { name: 'smallcode_read_file', description: 'Read file contents', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
        { name: 'smallcode_search', description: 'Search code with regex', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
        { name: 'smallcode_patch', description: 'Edit file via search-and-replace', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
        { name: 'smallcode_bash', description: 'Run shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'smallcode_memory_load', description: 'Load relevant project memory for a task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
        { name: 'smallcode_memory_remember', description: 'Save knowledge to project memory', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['type', 'title', 'content'] } },
        { name: 'smallcode_agent', description: 'Send a prompt to SmallCode agent', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
      ]}};
    case 'tools/call':
      return await handleMCPToolCall(id, request.params, options);
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` }};
  }
}

async function handleMCPToolCall(id, params, options) {
  const { name, arguments: args } = params;
  const cwd = process.cwd();
  let result = '';
  
  const currentTaskType = options.getCurrentTaskType ? options.getCurrentTaskType() : null;
  const currentLedgerRunId = options.getCurrentLedgerRunId ? options.getCurrentLedgerRunId() : null;
  const memoryStore = options.memoryStore;

  switch (name) {
    case 'smallcode_read_file': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${safe.reason}` }], isError: true }};
      try { result = sanitizeToolOutput(fs.readFileSync(safe.fullPath, 'utf-8')); }
      catch (e) { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }}; }
      break;
    }
    case 'smallcode_bash': {
      const command = String(args.command || '');
      if (/rm\s+-rf\s+\/[^.]/.test(command) || /format\s+c:/i.test(command)) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: destructive command blocked' }], isError: true }};
      }
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
        result = sanitizeToolOutput(output).slice(0, 4000);
      } catch (e) { result = sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000); }
      break;
    }
    case 'smallcode_search': {
      const pattern = String(args.pattern || '');
      const searchPath = args.path ? safeResolvePath(args.path, cwd) : { ok: true, fullPath: '.' };
      if (!searchPath.ok) { result = `Error: ${searchPath.reason}`; break; }
      try {
        const cmd = 'rg --line-number --max-count 10 ' + escapeShellArg(pattern) + ' ' + escapeShellArg(searchPath.fullPath || '.');
        result = sanitizeToolOutput(execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd })).slice(0, 3000);
      } catch { result = 'No matches'; }
      break;
    }
    case 'smallcode_patch': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) { result = `Error: ${safe.reason}`; break; }
      try {
        let content = fs.readFileSync(safe.fullPath, 'utf-8');
        if (!content.includes(args.old_str)) { result = 'Error: old_str not found'; break; }
        const count = content.split(args.old_str).length - 1;
        if (count > 1) { result = `Error: old_str matches ${count} locations`; break; }
        content = content.replace(args.old_str, args.new_str);
        fs.writeFileSync(safe.fullPath, content);
        result = `Patched ${args.path}`;
      } catch (e) { result = `Error: ${e.message}`; }
      break;
    }
    case 'smallcode_memory_load': {
      if (currentTaskType) {
        const auth = authorizeToolForAgent(name, currentTaskType);
        if (auth.authorized === false) {
          result = auth.reason;
          break;
        }
      }
      const objects = memoryStore.loadForTask(args.task || '', 2000, { taskType: currentTaskType, runId: currentLedgerRunId });
      const items = Array.isArray(objects) ? objects : (objects?.objects || []);
      result = items.length > 0
        ? items.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n')
        : 'No relevant memory found.';
      break;
    }
    case 'smallcode_memory_remember': {
      if (currentTaskType) {
        const auth = authorizeToolForAgent(name, currentTaskType);
        if (auth.authorized === false) {
          result = auth.reason;
          break;
        }
      }
      const obj = memoryStore.remember(args.type || 'context', args.title || '', args.content || '', { tags: args.tags || [] });
      if (obj.duplicate) {
        result = `Already known (confirmed existing: ${obj.existing_id})`;
      } else if (obj.rejected) {
        result = `Rejected: ${obj.reason}`;
      } else {
        result = `Remembered: [${obj.type}] ${obj.title} (${obj.id})`;
      }
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] }};
}

module.exports = {
  runMCP,
  handleMCPRequest,
  handleMCPToolCall
};
