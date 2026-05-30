// SmallCode — TUI Commands
// All /slash commands live here

const fs = require('fs');
const path = require('path');
const tui = require('./tui');
const chalk = tui.chalk;
const handlers = require('./commands_handlers');

module.exports = function createCommandHandler(config, conversationHistory, improvementAttempts, runAgentLoop, runValidation, MAX_IMPROVE_ITERATIONS, memoryStore, escalationEngine, tokenMonitor) {

  return async function handleCommand(cmd, rl) {
    const parts = cmd.split(' ');
    const ctx = {
      config,
      conversationHistory,
      improvementAttempts,
      runAgentLoop,
      runValidation,
      MAX_IMPROVE_ITERATIONS,
      memoryStore,
      escalationEngine,
      tokenMonitor,
      parts,
      rl,
      cmd
    };

    switch (parts[0]) {
      case '/quit': case '/q': case '/exit':
        rl.close();
        return;

      case '/clear':
        conversationHistory.length = 0;
        Object.keys(improvementAttempts).forEach(k => delete improvementAttempts[k]);
        console.log(chalk.green('  ✓ Session cleared.'));
        console.log('');
        rl.prompt();
        return;

      case '/model': {
        await handlers.handleModel(ctx);
        return;
      }

      case '/endpoint': {
        if (parts.length < 2) {
          console.log(`  Current: ${chalk.gray(config.model.baseUrl)}`);
          console.log(chalk.gray('  Switch: /endpoint http://host:port/v1'));
        } else {
          config.model.baseUrl = parts[1];
          delete config.activeModelTarget;
          console.log(`  ${chalk.green('✓')} Endpoint: ${chalk.gray(parts[1])}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/dashboard': {
        const { startDashboardServer } = require('../src/governor/dashboard_server');
        const requestedPort = parts[1] ? parseInt(parts[1], 10) : 3000;
        const port = isNaN(requestedPort) ? 3000 : requestedPort;
        try {
          startDashboardServer(port);
          console.log(`  ${chalk.green('✓')} Observability Dashboard running at: ${chalk.cyan('http://localhost:' + port)}`);
        } catch (e) {
          console.log(`  ${chalk.red('✗')} Failed to start dashboard server: ${e.message}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/stats':
        console.log(`  Model:    ${chalk.cyan(config.model.name)}`);
        console.log(`  Endpoint: ${chalk.gray(config.model.baseUrl)}`);
        console.log(`  History:  ${chalk.white(String(conversationHistory.length))} messages`);
        console.log(`  Files:    ${chalk.white(String(Object.keys(improvementAttempts).filter(k => k !== '__bash').length))} tracked`);
        console.log(`  Dir:      ${chalk.gray(process.cwd())}`);
        if (tokenMonitor) {
          console.log(`  Tokens:   ${chalk.white(tokenMonitor.formatShort())}`);
        }
        console.log('');
        rl.prompt();
        return;

      case '/tokens': {
        if (!tokenMonitor) {
          console.log(chalk.gray('  Token monitor not initialized.'));
        } else {
          console.log(chalk.bold('  ' + tokenMonitor.formatFull().split('\n').join('\n  ')));
          // Feature 3: show policy budget state
          try {
            const { getBudgetState } = require('./features_adapter');
            if (getBudgetState) {
              const bs = getBudgetState();
              if (bs) {
                console.log(`  Policy:    turns ${bs.run_turn.calls}/30 this min | tokens ${Math.round(bs.per_user_tokens.tokens/1000)}k/500k this hr`);
              }
            }
          } catch {}
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/budget': {
        const maxCtx = config.context?.detected_window || 128000;
        const budgetPct = config.context?.max_budget_pct || 70;
        const maxBudget = Math.round(maxCtx * (budgetPct / 100));
        const currentEst = conversationHistory.reduce((sum, m) => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return sum + Math.ceil(c.length / 4);
        }, 0);
        const usage = Math.round((currentEst / maxBudget) * 100);
        const bar = '█'.repeat(Math.min(20, Math.round(usage / 5))) + '░'.repeat(Math.max(0, 20 - Math.round(usage / 5)));
        console.log(chalk.bold('  Context Budget'));
        console.log(`  Window:    ${chalk.white(String(maxCtx))} tokens`);
        console.log(`  Budget:    ${chalk.white(String(maxBudget))} tokens (${budgetPct}%)`);
        console.log(`  Used:      ${chalk.white(String(currentEst))} tokens (~${usage}%)`);
        console.log(`  [${usage > 80 ? chalk.red(bar) : usage > 50 ? chalk.yellow(bar) : chalk.green(bar)}]`);
        if (tokenMonitor) {
          const m = tokenMonitor.getMetrics();
          console.log(`  Compacts:  ${chalk.white(String(m.compactions))} | Evictions: ${chalk.white(String(m.evictions))}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/trace': {
        await handlers.handleTrace(ctx);
        return;
      }

      case '/eval': {
        const { EvalRunner } = require('./eval_runner');
        const evalRunner = new EvalRunner(config);
        const suite = parts[1] || 'classify_accuracy';
        console.log(chalk.gray(`  Running evaluation: ${suite}...`));
        const results = await evalRunner.run(suite);
        if (results.error) {
          console.log(chalk.red(`  ${results.error}`));
        } else {
          console.log(EvalRunner.format(results));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/diff': {
        const { execSync } = require('child_process');
        try {
          const diff = execSync('git diff --stat', { encoding: 'utf-8', cwd: process.cwd() });
          if (diff.trim()) {
            console.log(chalk.bold('  Changes:'));
            for (const line of diff.trim().split('\n')) {
              console.log(`  ${line}`);
            }
          } else {
            console.log(chalk.gray('  No uncommitted changes.'));
          }
        } catch {
          console.log(chalk.gray('  Not a git repo.'));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/git': {
        const gitArgs = parts.slice(1);
        if (gitArgs.length === 0) {
          console.log(chalk.gray('  /git status │ /git log │ /git diff │ /git commit -m "msg"'));
          console.log('');
          rl.prompt();
          return;
        }
        // Use execFileSync with arg array to prevent shell injection.
        // /git status; rm -rf / would previously execute the rm command.
        const { execFileSync } = require('child_process');
        try {
          const output = execFileSync('git', gitArgs, { encoding: 'utf-8', cwd: process.cwd(), timeout: 10000 });
          console.log(output);
        } catch (e) {
          console.log(chalk.red(`  ${(e.stdout || '') + (e.stderr || e.message || '')}`));
        }
        rl.prompt();
        return;
      }

      case '/loop': {
        const targetFile = parts[1];
        if (!targetFile) {
          console.log(chalk.gray('  Usage: /loop <filepath>'));
          console.log('');
          rl.prompt();
          return;
        }
        const validation = runValidation(targetFile);
        if (!validation) {
          console.log(chalk.gray(`  No validator for ${targetFile}`));
        } else if (validation.passed) {
          console.log(`  ${chalk.green('✓')} ${targetFile} — no errors`);
        } else {
          console.log(tui.improvementLoop(validation.errors, 1, MAX_IMPROVE_ITERATIONS));
          console.log('');
          await runAgentLoop(`Fix these errors in ${targetFile}:\n${validation.errors.join('\n')}`, config);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/memory': {
        await handlers.handleMemory(ctx);
        return;
      }

      case '/compact': {
        if (conversationHistory.length > 10) {
          const removed = conversationHistory.splice(0, conversationHistory.length - 6);
          console.log(`  ${chalk.green('✓')} Removed ${removed.length} old messages, kept last 6.`);
        } else {
          console.log(chalk.gray(`  Short history (${conversationHistory.length} msgs), nothing to compact.`));
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/escalation': {
        if (!escalationEngine) {
          console.log(chalk.gray('  Escalation engine not initialized.'));
        } else if (!escalationEngine.enabled) {
          console.log(chalk.gray('  Escalation: disabled'));
          console.log(chalk.gray('  To enable, set ANTHROPIC_API_KEY or OPENAI_API_KEY env var'));
          console.log(chalk.gray('  Or add [escalation] section to smallcode.toml'));
        } else {
          console.log(`  ${chalk.magenta('⬆')} Escalation: ${chalk.green('enabled')}`);
          console.log(`  Provider: ${chalk.cyan(escalationEngine.provider)} (${escalationEngine.model})`);
          console.log(`  Used: ${escalationEngine.escalationCount}/${escalationEngine.maxEscalationsPerSession} this session`);
          console.log(`  Confirm: ${escalationEngine.confirmBeforeEscalate ? 'yes (will ask)' : 'no (auto)'}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/profile': {
        const { getProfile } = require('../src/model/profiles');
        const { getRoutingMode, estimateSavings } = require('../src/tools/two_stage_router');
        const profile = getProfile(config.model.name, config.context?.detected_window || 0);
        const mode = getRoutingMode(config.context?.detected_window || 32768, process.env.SMALLCODE_TOOL_ROUTING);
        console.log(chalk.bold('  Model Profile'));
        console.log(`  Model:     ${chalk.cyan(config.model.name)}`);
        console.log(`  Matched:   ${profile.matched_key ? chalk.green(profile.matched_key) : chalk.gray('none (using defaults)')}`);
        console.log(`  Context:   ${chalk.white(String(profile.context_length))} tokens`);
        console.log(`  Max out:   ${chalk.white(String(profile.max_output))} tokens`);
        console.log(`  Tools:     ${chalk.white(profile.tool_format)}`);
        console.log(`  Routing:   ${chalk.white(mode)}`);
        if (profile.strengths.length) console.log(`  Strengths: ${chalk.green(profile.strengths.join(', '))}`);
        if (profile.weaknesses.length) console.log(`  Weak:      ${chalk.yellow(profile.weaknesses.join(', '))}`);
        console.log('');
        rl.prompt();
        return;
      }

      case '/cognition': {
        // Phase A-D: Show MarrowScript-compiled cognition layer status
        let cognition = null;
        try { cognition = require('../src/compiled/cognition'); } catch {}
        if (!cognition) {
          console.log(chalk.gray('  Cognition layer: not loaded'));
          console.log(chalk.gray('  (compile marrow/smallcode_cognition.marrow → src/compiled/)'));
          console.log('');
          rl.prompt();
          return;
        }
        console.log(chalk.bold('  MarrowScript Cognition Layer'));
        console.log(`  Status:    ${chalk.green('● loaded')}`);
        try {
          const models = cognition.listModelNames ? cognition.listModelNames() : [];
          console.log(`  Models:    ${chalk.cyan(models.join(', ') || '(none)')}`);
        } catch {}
        try {
          const prompts = Object.keys(cognition.PROMPTS || {});
          console.log(`  Prompts:   ${chalk.cyan(prompts.join(', ') || '(none)')}`);
        } catch {}
        try {
          const routers = Object.keys(cognition.ROUTERS || {});
          console.log(`  Routers:   ${chalk.cyan(routers.join(', ') || '(none)')}`);
        } catch {}
        console.log(`  Logs:      ${process.env.SMALLCODE_COGNITION_LOG ? chalk.green('on (' + process.env.SMALLCODE_COGNITION_LOG + ')') : chalk.gray('off (set SMALLCODE_COGNITION_LOG=stdout to enable)')}`);
        console.log(chalk.gray('  Source:    marrow/smallcode_cognition.marrow'));
        console.log('');
        rl.prompt();
        return;
      }

      case '/mcp': {
        await handlers.handleMcp(ctx);
        return;
      }

      case '/skill': {
        await handlers.handleSkill(ctx);
        return;
      }

      case '/plugin': {
        await handlers.handlePlugin(ctx);
        return;
      }

      case '/undo': {
        await handlers.handleUndo(ctx);
        return;
      }

      case '/share': {
        const { exportToMarkdown, exportToGist } = require('../src/session/share');
        const sub = parts[1];
        if (conversationHistory.length === 0) {
          console.log(chalk.gray('  No session to share.'));
        } else if (sub === 'gist') {
          console.log(chalk.gray('  Creating gist...'));
          const session = { id: 'tmp', title: conversationHistory.find(m => m.role === 'user')?.content?.slice(0, 40) || '', messages: conversationHistory, model: config.model.name, createdAt: new Date().toISOString() };
          const result = exportToGist(session);
          if (result.success) {
            console.log(`  ${chalk.green('✓')} Shared: ${chalk.cyan(result.url)}`);
          } else {
            console.log(chalk.red(`  Failed: ${result.error}`));
          }
        } else {
          const outputPath = sub || `smallcode-session-${Date.now()}.md`;
          const session = { id: 'tmp', title: '', messages: conversationHistory, model: config.model.name, createdAt: new Date().toISOString() };
          exportToMarkdown(session, outputPath);
          console.log(`  ${chalk.green('✓')} Exported to ${chalk.cyan(outputPath)}`);
        }
        console.log('');
        rl.prompt();
        return;
      }

      case '/files': {
        await handlers.handleFiles(ctx);
        return;
      }

      case '/session': {
        await handlers.handleSession(ctx);
        return;
      }

      case '/sessions': {
        await handlers.handleSessions(ctx);
        return;
      }

      case '/version':
      case '/v': {
        // Read version from package.json (single source of truth).
        try {
          const pkg = require('../package.json');
          console.log('');
          console.log(`  ${chalk.bold('SmallCode')} ${chalk.cyan('v' + pkg.version)}`);
          if (pkg.description) console.log(`  ${chalk.gray(pkg.description)}`);
          console.log(`  ${chalk.gray('Node ' + process.version + ' on ' + process.platform + '/' + process.arch)}`);
          console.log('');
        } catch (e) {
          console.log(chalk.gray('  Version info unavailable: ' + e.message));
          console.log('');
        }
        rl.prompt();
        return;
      }

      case '/contract': {
        await handlers.handleContract(ctx);
        return;
      }

      case '/help':
        console.log('');
        console.log(chalk.bold('  Commands'));
        console.log(chalk.gray('  ─────────────────────────────────────'));
        console.log(`  ${chalk.cyan('/model')} <name>  ${chalk.gray('Switch model mid-session')}`);
        console.log(`  ${chalk.cyan('/endpoint')} <u>  ${chalk.gray('Switch API endpoint')}`);
        console.log(`  ${chalk.cyan('/stats')}         ${chalk.gray('Model, history, cwd')}`);
        console.log(`  ${chalk.cyan('/files')}         ${chalk.gray('List project files')}`);
        console.log(`  ${chalk.cyan('/diff')}          ${chalk.gray('Git diff summary')}`);
        console.log(`  ${chalk.cyan('/git')} <cmd>     ${chalk.gray('Run any git command')}`);
        console.log(`  ${chalk.cyan('/loop')} <file>   ${chalk.gray('Validate + auto-fix')}`);
        console.log(`  ${chalk.cyan('/memory')}        ${chalk.gray('View/manage project memory')}`);
        console.log(`  ${chalk.cyan('/contract')}      ${chalk.gray('Definition-of-Done contract')}`);
        console.log(`  ${chalk.cyan('/undo')}          ${chalk.gray('Revert uncommitted changes')}`);
        console.log(`  ${chalk.cyan('/compact')}       ${chalk.gray('Trim conversation history')}`);
        console.log(`  ${chalk.cyan('/escalation')}    ${chalk.gray('View model escalation status')}`);
        console.log(`  ${chalk.cyan('/profile')}       ${chalk.gray('Show detected model profile')}`);
        console.log(`  ${chalk.cyan('/cognition')}     ${chalk.gray('Show MarrowScript cognition layer status')}`);
        console.log(`  ${chalk.cyan('/tokens')}        ${chalk.gray('Detailed token usage report')}`);
        console.log(`  ${chalk.cyan('/budget')}        ${chalk.gray('Show context window budget')}`);
        console.log(`  ${chalk.cyan('/mcp')}           ${chalk.gray('Show connected MCP servers')}`);
        console.log(`  ${chalk.cyan('/skill')}         ${chalk.gray('Manage reusable skills')}`);
        console.log(`  ${chalk.cyan('/plugin')}        ${chalk.gray('List installed plugins')}`);
        console.log(`  ${chalk.cyan('/provider')}      ${chalk.gray('Configure LLM provider (interactive wizard)')}`);
        console.log(`  ${chalk.cyan('/sessions')}      ${chalk.gray('List/resume saved sessions')}`);
        console.log(`  ${chalk.cyan('/trace')}         ${chalk.gray('View/export execution traces')}`);
        console.log(`  ${chalk.cyan('/eval')} <suite>   ${chalk.gray('Run prompt evaluation')}`);
        console.log(`  ${chalk.cyan('/clear')}         ${chalk.gray('Reset entire session')}`);
        console.log(`  ${chalk.cyan('/version')}       ${chalk.gray('Show SmallCode version')}`);
        console.log(`  ${chalk.cyan('/quit')}          ${chalk.gray('Exit SmallCode')}`);
        console.log('');
        rl.prompt();
        return;

      case '/provider': {
        const sub = (parts[1] || '').trim();
        if (sub === 'status' || sub === '--status' || sub === '-s') {
          const pProviderStatus = require('./provider-wizard/tool-status');
          console.log(pProviderStatus());
        } else {
          const pWizard = require('./provider-wizard/wizard');
          const result = await pWizard.runWizard({ interactive: true });
          if (result.success) {
            console.log(result.provider || '');
          }
        }
        console.log('');
        rl.prompt();
        return;
      }

      default: {
        // Try plugin commands — strip leading / for lookup
        const { PluginLoader } = require('../src/plugins/loader');
        const pl = new PluginLoader(process.cwd()).loadAll();
        const cmdName = parts[0].replace(/^\//, '');
        if (pl.commands[cmdName]) {
          const result = await pl.executeCommand(cmdName, parts.slice(1).join(' '), { config, conversationHistory });
          if (result) console.log(result);
        } else {
          console.log(chalk.gray(`  Unknown: ${parts[0]}. Type /help`));
        }
        console.log('');
        rl.prompt();
        return;
      }
    }
  };
};
