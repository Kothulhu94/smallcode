// SmallCode — MCP Client (Runtime)
// Compiled from: src/tools/mcp_client.ms
//
// Connects TO external MCP servers and exposes their tools to the agent.
// Config: .smallcode/mcp.json (project) or ~/.config/smallcode/mcp.json (user)
//
// Example mcp.json:
// {
//   "mcpServers": {
//     "github": {
//       "command": "uvx",
//       "args": ["mcp-server-github"],
//       "env": { "GITHUB_TOKEN": "..." }
//     }
//   }
// }

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class MCPClient {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.servers = new Map(); // name → { config, process, connected, tools }
    this.tools = []; // flat list of all discovered tools
    this._requestId = 1;
  }

  /**
   * Load MCP configuration from project + user level.
   * Project config overrides user config for same server names.
   */
  loadConfig() {
    const configPaths = [
      path.join(os.homedir(), '.config', 'smallcode', 'mcp.json'),
      path.join(this.projectDir, '.smallcode', 'mcp.json'),
    ];

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      try {
        const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const servers = content.mcpServers || {};
        for (const [name, cfg] of Object.entries(servers)) {
          if (cfg.disabled) continue;
          this.servers.set(name, {
            config: {
              name,
              command: cfg.command || '',
              args: cfg.args || [],
              env: cfg.env || {},
              autoApprove: cfg.autoApprove || [],
            },
            process: null,
            connected: false,
            tools: [],
          });
        }
      } catch {}
    }

    return this.servers.size;
  }

  /**
   * Connect to all configured servers and discover their tools.
   * Returns number of tools discovered.
   */
  async connectAll() {
    let totalTools = 0;
    for (const [name, server] of this.servers) {
      try {
        const tools = await this._connectServer(name, server);
        totalTools += tools;
      } catch {}
    }
    return totalTools;
  }

  /**
   * Get tool definitions formatted for the OpenAI tools array.
   */
  getToolDefs() {
    return this.tools.map(t => ({
      type: 'function',
      function: {
        name: `mcp__${t.serverName}__${t.name}`,
        description: `[${t.serverName}] ${t.description}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Execute a tool call on the appropriate MCP server.
   * @param {string} fullName - Tool name in format mcp__serverName__toolName
   * @param {object} args - Tool arguments
   * @returns {object} { result, error }
   */
  async callTool(fullName, args) {
    // Parse mcp__serverName__toolName
    const parts = fullName.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return { error: `Invalid MCP tool name: ${fullName}` };
    }
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__'); // Handle tools with __ in name

    const server = this.servers.get(serverName);
    if (!server || !server.connected) {
      return { error: `MCP server '${serverName}' is not connected` };
    }

    try {
      const response = await this._sendRequest(server, 'tools/call', {
        name: toolName,
        arguments: args,
      });

      if (!response) return { error: `No response from ${serverName}` };

      const content = response.content || [];
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');

      if (response.isError) {
        return { error: text || 'MCP tool returned error' };
      }
      return { result: text || '(no output)' };
    } catch (err) {
      return { error: `MCP call failed: ${err.message}` };
    }
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMCPTool(name) {
    return name.startsWith('mcp__');
  }

  /**
   * List connected servers and their tools (for /mcp command).
   */
  status() {
    const result = [];
    for (const [name, server] of this.servers) {
      result.push({
        name,
        connected: server.connected,
        tools: server.tools.map(t => t.name),
        command: server.config.command,
      });
    }
    return result;
  }

  /**
   * Disconnect all servers.
   */
  disconnect() {
    for (const [, server] of this.servers) {
      if (server.process) {
        try { server.process.kill(); } catch {}
        server.process = null;
        server.connected = false;
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  async _connectServer(name, server) {
    const { config } = server;
    if (!config.command) return 0;

    // Spawn the MCP server process
    const env = { ...process.env, ...config.env };
    try {
      server.process = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.projectDir,
        env,
      });
    } catch (err) {
      return 0;
    }

    server.process.on('error', () => { server.connected = false; });
    server.process.on('exit', () => { server.connected = false; server.process = null; });

    // Initialize
    const initResult = await this._sendRequest(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smallcode', version: '0.4.18' },
    });

    if (!initResult) {
      if (server.process) { server.process.kill(); server.process = null; }
      return 0;
    }

    // Send initialized notification
    this._sendNotification(server, 'notifications/initialized', {});

    server.connected = true;

    // List tools
    const toolsResult = await this._sendRequest(server, 'tools/list', {});
    if (toolsResult && toolsResult.tools) {
      for (const tool of toolsResult.tools) {
        const mcpTool = {
          serverName: name,
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        };
        server.tools.push(mcpTool);
        this.tools.push(mcpTool);
      }
    }

    return server.tools.length;
  }

  _sendRequest(server, method, params) {
    return new Promise((resolve) => {
      if (!server.process || !server.process.stdin || !server.process.stdout) {
        resolve(null);
        return;
      }

      const id = this._requestId++;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            if (resp.id === id) {
              server.process.stdout.off('data', onData);
              resolve(resp.result || null);
            }
          } catch {}
        }
      };

      server.process.stdout.on('data', onData);
      server.process.stdin.write(request);

      // Timeout after 10s
      setTimeout(() => {
        if (server.process) server.process.stdout.off('data', onData);
        resolve(null);
      }, 10000);
    });
  }

  _sendNotification(server, method, params) {
    if (!server.process || !server.process.stdin) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { server.process.stdin.write(msg); } catch {}
  }
}

module.exports = { MCPClient };
