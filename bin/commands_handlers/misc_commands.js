'use strict';
const fs = require('fs');
const path = require('path');
const tui = require('../tui');
const chalk = tui.chalk;

async function handleModel(ctx) {
  const { parts, config, rl } = ctx;
  if (parts.length < 2) {
    // Show current model + fetch available models from endpoint
    console.log(`  Current: ${chalk.cyan(config.model.name)}`);
    console.log(`  Endpoint: ${chalk.gray(config.model.baseUrl)}`);
    console.log('');
    process.stdout.write(chalk.gray('  Fetching available models... '));
    try {
      // Build auth headers — required by OpenWebUI and other authenticated endpoints
      const modelListHeaders = { 'Content-Type': 'application/json' };
      const apiKey = process.env.SMALLCODE_API_KEY || process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
      if (apiKey) modelListHeaders['Authorization'] = `Bearer ${apiKey}`;

      const resp = await fetch(`${config.model.baseUrl}/models`, { headers: modelListHeaders });
      if (resp.ok) {
        const data = await resp.json();
        const models = data.data || data.models || [];
        console.log(chalk.green(`${models.length} found`));
        console.log('');
        for (const m of models) {
          const id = m.id || m.name || '';
          const active = id === config.model.name ? chalk.green(' ← active') : '';
          console.log(`    ${chalk.white(id)}${active}`);
        }
        console.log('');
        console.log(chalk.gray('  Switch: /model <name>'));
      } else {
        console.log(chalk.red(`failed (HTTP ${resp.status})`));
      }
    } catch (e) {
      console.log(chalk.red(`error: ${e.message}`));
    }
  } else {
    const newModel = parts.slice(1).join(' ');
    config.model.name = newModel;
    delete config.activeModelTarget;
    console.log(`  ${chalk.green('✓')} Switched to ${chalk.cyan(newModel)}`);
  }
  console.log('');
  rl.prompt();
}

async function handleUndo(ctx) {
  const { parts, rl } = ctx;
  const sub = parts[1];
  if (sub === 'list') {
    const edits = (global._smallcodeUndo || { list: () => [] }).list(10);
    if (edits.length === 0) {
      console.log(chalk.gray('  No edits to undo.'));
    } else {
      console.log(chalk.bold('  Recent edits:'));
      for (const e of edits) {
        console.log(`    ${chalk.cyan(`#${e.id}`)} ${chalk.white(e.path)} ${chalk.gray(`(${e.type}, ${e.age}s ago)`)}`);
      }
      console.log(chalk.gray('\n  /undo       Revert last edit'));
      console.log(chalk.gray('  /undo <id>  Revert specific edit'));
      console.log(chalk.gray('  /undo all   Git revert all changes'));
    }
  } else if (sub === 'all') {
    const { execSync } = require('child_process');
    try {
      execSync('git checkout -- .', { encoding: 'utf-8', cwd: process.cwd() });
      console.log(`  ${chalk.green('✓')} Reverted all uncommitted changes.`);
    } catch {
      console.log(chalk.red('  Not a git repo.'));
    }
  } else if (sub && !isNaN(sub)) {
    const result = (global._smallcodeUndo || { undoById: () => null }).undoById(parseInt(sub));
    if (result && !result.error) {
      console.log(`  ${chalk.green('✓')} Reverted ${result.reverted}: ${result.action}`);
    } else {
      console.log(chalk.red(`  ${result?.error || 'Edit not found.'}`));
    }
  } else {
    const result = (global._smallcodeUndo || { undoLast: () => null }).undoLast();
    if (result && !result.error) {
      console.log(`  ${chalk.green('✓')} Reverted ${result.reverted}: ${result.action}`);
    } else if (result?.error) {
      console.log(chalk.red(`  ${result.error}`));
    } else {
      console.log(chalk.gray('  No edits to undo. Use /undo all for git revert.'));
    }
  }
  console.log('');
  rl.prompt();
}

async function handleMemory(ctx) {
  const { parts, memoryStore, rl } = ctx;
  const sub = parts[1];
  if (!sub || sub === 'list') {
    try {
      const stats = memoryStore.stats();
      if (stats.total === 0) {
        console.log(chalk.gray('  No memory stored. The model will save decisions/workflows/gotchas as it works.'));
      } else {
        console.log(chalk.bold(`  Project memory (${stats.total} objects):`));
        const objects = memoryStore.all();
        for (const o of objects) {
          console.log(`    ${chalk.cyan(`[${o.type}]`)} ${chalk.white(o.title)} ${chalk.gray(`(${o.id})`)}`);
        }
      }
    } catch (e) {
      console.log(chalk.gray(`  Memory error: ${e.message}`));
    }
  } else if (sub === 'clear') {
    try {
      const objs = memoryStore.all();
      for (const o of objs) memoryStore.forget(o.id);
      console.log(chalk.green('  ✓ Memory cleared.'));
    } catch (e) {
      console.log(chalk.gray(`  Error: ${e.message}`));
    }
  } else {
    console.log(chalk.gray('  /memory         List stored memory'));
    console.log(chalk.gray('  /memory clear   Clear all memory'));
  }
  console.log('');
  rl.prompt();
}

async function handleMcp(ctx) {
  const { rl } = ctx;
  const { MCPClient } = require('../../src/tools/mcp_client');
  const client = new MCPClient(process.cwd());
  const serverCount = client.loadConfig();
  if (serverCount === 0) {
    console.log(chalk.gray('  No MCP servers configured.'));
    console.log(chalk.gray('  Add .smallcode/mcp.json to connect external tools.'));
    console.log(chalk.gray('  Example: { "mcpServers": { "github": { "command": "uvx", "args": ["mcp-server-github"] } } }'));
  } else {
    // Check if global mcpClient is connected
    if (typeof mcpClient !== 'undefined' && mcpClient) {
      const status = mcpClient.status();
      console.log(chalk.bold(`  MCP Servers (${status.length}):`));
      for (const s of status) {
        const state = s.connected ? chalk.green('● connected') : chalk.red('○ disconnected');
        console.log(`    ${state} ${chalk.cyan(s.name)} (${s.command})`);
        if (s.tools.length) console.log(`      Tools: ${s.tools.join(', ')}`);
      }
    } else {
      console.log(chalk.gray(`  ${serverCount} server(s) configured but not yet connected.`));
      console.log(chalk.gray('  They connect automatically on first tool use.'));
    }
  }
  console.log('');
  rl.prompt();
}

async function handleFiles(ctx) {
  const { rl } = ctx;
  const { getActiveTargetRoot } = require('../../src/governor/project_workspace');
  const targetRoot = getActiveTargetRoot();

  let listDir = null;
  let label = '';

  if (!targetRoot.ok) {
    if (targetRoot.reason === 'no_active_workspace') {
      // No workspace active — fall back to harness root with a clear label
      listDir = process.cwd();
      label = chalk.yellow('  [No active workspace — showing harness root files]');
    } else if (targetRoot.reason === 'no_root_path') {
      console.log(chalk.yellow('  Active workspace has no target project root set.'));
      console.log(chalk.gray('  Use workspace_create with a rootPath argument, or set one via the model.'));
      console.log('');
      rl.prompt();
      return;
    } else {
      // invalid_root_path
      console.log(chalk.red(`  Active workspace rootPath is invalid: ${targetRoot.detail || 'unknown error'}`));
      console.log(chalk.gray('  Update the workspace rootPath to a valid absolute directory.'));
      console.log('');
      rl.prompt();
      return;
    }
  } else {
    listDir = targetRoot.rootPath;
    label = chalk.green(`  [Workspace project root: ${listDir}]`);
  }

  console.log(label);
  const { execSync } = require('child_process');
  try {
    const output = execSync('git ls-files', { encoding: 'utf-8', cwd: listDir });
    const files = output.trim().split('\n').filter(Boolean);
    console.log(chalk.bold(`  Project files (${files.length}):`));
    for (const f of files.slice(0, 30)) {
      console.log(chalk.gray(`    ${f}`));
    }
    if (files.length > 30) console.log(chalk.gray(`    ... (${files.length - 30} more)`));
  } catch {
    try {
      const entries = fs.readdirSync(listDir).slice(0, 20);
      console.log(chalk.bold(`  Directory listing (not a git repo):`));
      for (const e of entries) console.log(chalk.gray(`    ${e}`));
    } catch (readErr) {
      console.log(chalk.red(`  Cannot list files: ${readErr.message}`));
    }
  }
  console.log('');
  rl.prompt();
}

module.exports = {
  handleModel,
  handleUndo,
  handleMemory,
  handleMcp,
  handleFiles
};
