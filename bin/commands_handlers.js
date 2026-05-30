// SmallCode — TUI Command Handlers
// Extracted from bin/commands.js to keep file lengths under 500 lines.

'use strict';

const fs = require('fs');
const path = require('path');
const tui = require('./tui');
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

async function handleTrace(ctx) {
  const { parts, rl } = ctx;
  const { TraceRecorder } = require('./trace_recorder');
  const tr = new TraceRecorder(process.cwd());
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const traces = tr.list();
    if (traces.length === 0) {
      console.log(chalk.gray('  No traces recorded yet.'));
      console.log(chalk.gray('  Traces are recorded automatically for each turn.'));
    } else {
      console.log(chalk.bold(`  Traces (${traces.length}):`));
      for (const t of traces.slice(0, 15)) {
        const tok = t.tokens ? `${t.tokens.prompt + t.tokens.completion}tok` : '?';
        console.log(`    ${chalk.cyan(t.id)} ${chalk.white(t.prompt)} ${chalk.gray(`${t.steps} steps, ${tok}, ${t.durationMs}ms`)}`);
      }
    }
  } else if (sub === 'show') {
    const id = parts[2];
    if (!id) { console.log(chalk.gray('  Usage: /trace show <id>')); }
    else {
      const trace = tr.load(id);
      if (!trace) { console.log(chalk.red(`  Trace ${id} not found.`)); }
      else {
        console.log(chalk.bold(`  Trace ${trace.id}`));
        console.log(`  Prompt: ${chalk.white(trace.prompt.slice(0, 80))}`);
        console.log(`  Model:  ${chalk.cyan(trace.model)}`);
        console.log(`  Tokens: ${trace.tokens.prompt}p + ${trace.tokens.completion}c`);
        console.log(`  Steps:`);
        for (const step of trace.steps) {
          if (step.type === 'tool_call') {
            console.log(`    ${chalk.green('⚙')} ${step.name} (${step.durationMs}ms)`);
          } else if (step.type === 'validation') {
            const mark = step.passed ? chalk.green('✓') : chalk.red('✗');
            console.log(`    ${mark} validate ${step.filePath}`);
          }
        }
      }
    }
  } else if (sub === 'test') {
    const id = parts[2];
    if (!id) { console.log(chalk.gray('  Usage: /trace test <id>')); }
    else {
      const testCode = tr.generateTest(id);
      if (!testCode) { console.log(chalk.red(`  Cannot generate test from trace ${id}.`)); }
      else {
        const outPath = `.test-workspace/trace_${id}.test.js`;
        fs.writeFileSync(path.join(process.cwd(), outPath), testCode);
        console.log(chalk.green(`  ✓ Generated ${outPath}`));
      }
    }
  } else {
    console.log(chalk.gray('  /trace list          List recorded traces'));
    console.log(chalk.gray('  /trace show <id>     Show trace details'));
    console.log(chalk.gray('  /trace test <id>     Generate test from trace'));
  }
  console.log('');
  rl.prompt();
}

async function handlePlugin(ctx) {
  const { parts, config, conversationHistory, rl } = ctx;
  const { PluginLoader } = require('../src/plugins/loader');
  const pl = new PluginLoader(process.cwd()).loadAll();
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const plugins = pl.list();
    if (plugins.length === 0) {
      console.log(chalk.gray('  No plugins installed.'));
      console.log(chalk.gray('  Install: /plugin install <npm-package-or-github-url>'));
    } else {
      console.log(chalk.bold(`  Plugins (${plugins.length}):`));
      for (const p of plugins) {
        console.log(`    ${chalk.cyan(p.name)} v${p.version} — ${chalk.gray(p.description)}`);
        if (p.tools.length) console.log(`      Tools: ${p.tools.join(', ')}`);
        if (p.commands.length) console.log(`      Commands: ${p.commands.join(', ')}`);
      }
    }
  } else if (sub === 'install') {
    const pkg = parts[2];
    if (!pkg) {
      console.log(chalk.gray('  Usage: /plugin install <pkg> [--scope project|user|global]'));
      console.log(chalk.gray('  Examples:'));
      console.log(chalk.gray('    /plugin install smallcode-plugin-lint'));
      console.log(chalk.gray('    /plugin install github:user/repo --scope global'));
      console.log(chalk.gray('    /plugin install @scope/pkg --scope user'));
    } else {
      // Parse --scope flag
      let scope = 'project';
      const scopeIdx = parts.indexOf('--scope');
      if (scopeIdx !== -1 && parts[scopeIdx + 1]) {
        scope = parts[scopeIdx + 1];
      }
      const validScopes = { project: '.smallcode', user: '.smallcode', global: '.config/smallcode' };
      if (!validScopes[scope]) {
        console.log(chalk.red(`  ✗ Unknown scope "${scope}". Use: project, user, or global.`));
      } else {
        const os = require('os');
        const { execFileSync } = require('child_process');
        const pluginsDir = scope === 'project'
          ? require('path').join(process.cwd(), '.smallcode', 'plugins')
          : require('path').join(os.homedir(), validScopes[scope], 'plugins');
        const fs = require('fs');
        if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
        if (!/^[@a-zA-Z0-9._\-/: ]+$/.test(pkg)) {
          console.log(chalk.red(`  ✗ Invalid package name: ${pkg}`));
        } else {
          console.log(chalk.gray(`  Installing ${pkg} (${scope} → ${pluginsDir})...`));
          try {
            execFileSync('npm', ['install', '--prefix', pluginsDir, pkg], { encoding: 'utf-8', timeout: 60000, cwd: process.cwd() });
            console.log(chalk.green(`  ✓ Installed ${pkg}`));
            console.log(chalk.gray('  Restart SmallCode to activate.'));
          } catch (e) {
            console.log(chalk.red(`  ✗ Install failed: ${((e.stderr || '') + (e.message || '')).slice(0, 200)}`));
          }
        }
      }
    }
  } else if (sub === 'remove') {
    const pkg = parts[2];
    if (!pkg) {
      console.log(chalk.gray('  Usage: /plugin remove <name> [--scope project|user|global]'));
    } else {
      let scope = 'project';
      const scopeIdx = parts.indexOf('--scope');
      if (scopeIdx !== -1 && parts[scopeIdx + 1]) {
        scope = parts[scopeIdx + 1];
      }
      const os = require('os');
      const scopeMap = { project: '.smallcode', user: '.smallcode', global: '.config/smallcode' };
      const pluginDir = scope === 'project'
        ? require('path').join(process.cwd(), '.smallcode', 'plugins', pkg)
        : require('path').join(os.homedir(), scopeMap[scope], 'plugins', pkg);
      const fs = require('fs');
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true });
        console.log(chalk.green(`  ✓ Removed ${pkg} (${scope})`));
      } else {
        console.log(chalk.red(`  Plugin "${pkg}" not found in ${scope} plugins dir`));
      }
    }
  } else {
    console.log(chalk.gray('  /plugin list                           Show installed plugins'));
    console.log(chalk.gray('  /plugin install <pkg> [--scope ...]    Install (default: project)'));
    console.log(chalk.gray('  /plugin remove <name> [--scope ...]    Remove a plugin'));
    console.log(chalk.gray('  Scopes: project (./.smallcode), user (~/.smallcode), global (~/.config/smallcode)'));
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

async function handleSkill(ctx) {
  const { parts, conversationHistory, rl } = ctx;
  const { SkillManager } = require('../src/plugins/skills');
  const sm = new SkillManager(process.cwd());
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const skills = sm.list();
    if (skills.length === 0) {
      console.log(chalk.gray('  No skills defined.'));
      console.log(chalk.gray('  Create one: /skill add <name>'));
      console.log(chalk.gray('  Skills teach the model reusable behaviors.'));
    } else {
      console.log(chalk.bold(`  Skills (${skills.length}):`));
      for (const s of skills) {
        const trigger = s.trigger === 'auto' ? chalk.green('auto') : s.trigger === 'match' ? chalk.yellow('match') : chalk.gray('manual');
        console.log(`    ${chalk.cyan(s.name)} [${trigger}] ${chalk.gray(s.preview)}`);
      }
    }
  } else if (sub === 'use') {
    const name = parts[2];
    if (!name) { console.log(chalk.gray('  Usage: /skill use <name>')); }
    else {
      const skill = sm.get(name);
      if (!skill) { console.log(chalk.red(`  Skill "${name}" not found.`)); }
      else {
        // Inject into conversation as a system message
        conversationHistory.push({ role: 'system', content: `[Skill: ${skill.name}]\n${skill.content}` });
        console.log(chalk.green(`  ✓ Skill "${skill.name}" activated for this conversation.`));
      }
    }
  } else if (sub === 'add') {
    const name = parts[2];
    if (!name) { console.log(chalk.gray('  Usage: /skill add <name>')); }
    else {
      const content = parts.slice(3).join(' ') || 'Describe the skill behavior here.';
      const skill = sm.add(name, content, { trigger: 'manual' });
      console.log(chalk.green(`  ✓ Created skill "${name}" at ${skill.path}`));
      console.log(chalk.gray('  Edit the .md file to customize the skill content.'));
    }
  } else if (sub === 'remove') {
    const name = parts[2];
    if (!name) { console.log(chalk.gray('  Usage: /skill remove <name>')); }
    else {
      const ok = sm.remove(name);
      console.log(ok ? chalk.green(`  ✓ Removed "${name}"`) : chalk.red(`  Skill "${name}" not found.`));
    }
  } else {
    console.log(chalk.gray('  /skill list          Show all skills'));
    console.log(chalk.gray('  /skill use <name>    Activate a skill'));
    console.log(chalk.gray('  /skill add <name>    Create a new skill'));
    console.log(chalk.gray('  /skill remove <name> Delete a skill'));
  }
  console.log('');
  rl.prompt();
}

async function handleSession(ctx) {
  const { parts, conversationHistory, rl } = ctx;
  const { MultiSessionManager } = require('../src/session/multi');
  if (!global._smallcodeMulti) global._smallcodeMulti = new MultiSessionManager();
  const msm = global._smallcodeMulti;
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const sessions = msm.list();
    if (sessions.length === 0) {
      console.log(chalk.gray('  No parallel sessions. Use /session new <task>'));
    } else {
      console.log(chalk.bold(`  Parallel sessions (${sessions.length}):`));
      for (const s of sessions) {
        const marker = s.active ? chalk.green(' ●') : '  ';
        console.log(`  ${marker} ${chalk.cyan(s.id)} ${chalk.white(s.title)} ${chalk.gray(`${s.messages} msgs, ${s.age}s`)}`);
      }
    }
  } else if (sub === 'new') {
    const title = parts.slice(2).join(' ') || undefined;
    const s = msm.create(title);
    conversationHistory.length = 0; // Clear current for new session
    console.log(`  ${chalk.green('✓')} New session ${chalk.cyan(s.id)}: ${s.title}`);
  } else if (sub === 'switch') {
    const id = parts[2];
    if (!id) { console.log(chalk.gray('  Usage: /session switch <id>')); }
    else {
      const s = msm.switch(id);
      if (s) {
        conversationHistory.length = 0;
        conversationHistory.push(...s.messages);
        console.log(`  ${chalk.green('✓')} Switched to ${chalk.cyan(s.id)}: ${s.title}`);
      } else {
        console.log(chalk.red(`  Session ${id} not found.`));
      }
    }
  } else if (sub === 'kill') {
    const id = parts[2];
    if (!id) { console.log(chalk.gray('  Usage: /session kill <id>')); }
    else {
      const ok = msm.kill(id);
      console.log(ok ? chalk.green(`  ✓ Killed ${id}`) : chalk.red(`  Not found: ${id}`));
    }
  } else {
    console.log(chalk.gray('  /session list          Show parallel sessions'));
    console.log(chalk.gray('  /session new <task>    Start new session'));
    console.log(chalk.gray('  /session switch <id>   Switch focus'));
    console.log(chalk.gray('  /session kill <id>     Terminate session'));
  }
  console.log('');
  rl.prompt();
}

async function handleSessions(ctx) {
  const { parts, conversationHistory, rl } = ctx;
  const { SessionStore } = require('../src/session/persistence');
  const ss = new SessionStore(process.cwd());
  const sub = parts[1];
  const sessions = ss.list();

  if (sub === 'resume' || sub === 'load') {
    const id = parts[2];
    if (!id) {
      console.log(chalk.gray('  Usage: /sessions resume <id>'));
    } else {
      const loaded = ss.load(id);
      if (loaded) {
        conversationHistory.length = 0;
        conversationHistory.push(...loaded.messages);
        console.log(chalk.green(`  ✓ Resumed "${loaded.title || 'untitled'}" (${loaded.messages.length} msgs)`));
      } else {
        console.log(chalk.red(`  Session ${id} not found.`));
      }
    }
  } else {
    if (sessions.length === 0) {
      console.log(chalk.gray('  No saved sessions.'));
    } else {
      console.log(chalk.bold(`  Sessions (${sessions.length}):`));
      for (const s of sessions.slice(0, 15)) {
        const age = Math.floor((Date.now() - new Date(s.updatedAt).getTime()) / 60000);
        const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age/60)}h ago` : `${Math.floor(age/1440)}d ago`;
        console.log(`    ${chalk.cyan(s.id.slice(0, 8))} ${chalk.white(s.title || 'untitled')} ${chalk.gray(`${s.msgs} msgs · ${ageStr}`)}`);
      }
      console.log(chalk.gray('\n  Resume: /sessions resume <id>'));
    }
  }
  console.log('');
  rl.prompt();
}

async function handleMcp(ctx) {
  const { rl } = ctx;
  const { MCPClient } = require('../src/tools/mcp_client');
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

async function handleContract(ctx) {
  const { parts, rl } = ctx;
  const { getStore } = require('../src/session/contract_store');
  const { formatStatus, statusPayload } = require('../src/session/contract_tools');
  const store = getStore(process.cwd());
  const sub = parts[1];

  if (!sub || sub === 'status') {
    const payload = statusPayload(store);
    console.log('');
    console.log(formatStatus(payload));
    console.log('');
  } else if (sub === 'list') {
    const all = store.list();
    if (all.length === 0) {
      console.log(chalk.gray('  No contracts. Use /contract create <title>...'));
    } else {
      const activeId = store.activeId();
      for (const row of all) {
        const marker = row.id === activeId ? chalk.green('●') : ' ';
        const ds = row.doneStatus;
        console.log(`  ${marker} ${chalk.cyan(row.id)}  [${row.status}]  ${row.title}  ${chalk.gray(`(${ds.passed}/${ds.total})`)}`);
      }
    }
    console.log('');
  } else if (sub === 'activate') {
    const id = parts[2];
    if (!id) { console.log(chalk.gray('  Usage: /contract activate <id>')); }
    else {
      try { store.activate(id); console.log(chalk.green(`  ✓ Activated ${id}`)); }
      catch (e) { console.log(chalk.red(`  ${e.message}`)); }
    }
    console.log('');
  } else if (sub === 'deactivate') {
    store.deactivate();
    console.log(chalk.gray('  Active contract cleared.'));
    console.log('');
  } else if (sub === 'abort') {
    const reason = parts.slice(2).join(' ') || '';
    try { const c = store.abort(reason); console.log(chalk.yellow(`  ⊘ Aborted ${c.id}`)); }
    catch (e) { console.log(chalk.red(`  ${e.message}`)); }
    console.log('');
  } else {
    console.log(chalk.gray('  /contract                Show active contract status'));
    console.log(chalk.gray('  /contract list           List all contracts'));
    console.log(chalk.gray('  /contract activate <id>  Switch active contract'));
    console.log(chalk.gray('  /contract deactivate     Clear active contract'));
    console.log(chalk.gray('  /contract abort <reason> Abort the active contract'));
    console.log(chalk.gray(''));
    console.log(chalk.gray('  Note: contracts are normally created by the agent via the'));
    console.log(chalk.gray('        contract_create tool. The model can\'t deliver "done"'));
    console.log(chalk.gray('        while any assertion is pending or failed.'));
    console.log('');
  }
  rl.prompt();
}

async function handleFiles(ctx) {
  const { rl } = ctx;
  const { getActiveTargetRoot } = require('../src/governor/project_workspace');
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
  handleTrace,
  handlePlugin,
  handleUndo,
  handleMemory,
  handleSkill,
  handleSession,
  handleSessions,
  handleMcp,
  handleContract,
  handleFiles
};
