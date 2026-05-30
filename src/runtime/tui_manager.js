const chalk = require('chalk');
const readline = require('readline');

async function runTUI(options) {
  const {
    config,
    flags,
    conversationHistory,
    improvementAttempts,
    runAgentLoop,
    runValidation,
    MAX_IMPROVE_ITERATIONS,
    memoryStore,
    escalationEngine,
    tokenMonitor,
    tokenTracker,
    sessionStore,
    killMCP,
    logEvent,
    EVENT_TYPES,
    tui,
    checkOllama,
    initCodeGraph,
    _lspClient,
    setFullscreenRef
  } = options;

  const createCommandHandler = require('../../bin/commands');
  const handleCmd = createCommandHandler(config, conversationHistory, improvementAttempts, runAgentLoop, runValidation, MAX_IMPROVE_ITERATIONS, memoryStore, escalationEngine, tokenMonitor);

  const ok = await checkOllama(config);
  if (!ok && config.model.provider === 'ollama') {
    process.exit(1);
  }

  // Start built-in code graph MCP
  let graphOk = false;
  process.stdout.write(chalk.gray('  Code graph: '));
  graphOk = await initCodeGraph();
  if (graphOk) {
    console.log(chalk.green('✓ indexed'));
  } else {
    console.log(chalk.gray('disabled'));
  }

  // ─── FULLSCREEN TUI (default) ─────────────────────────────────────────
  if (!flags.classic) {
    const { FullScreenTUI } = require('../tui/fullscreen.js');

    const screen = new FullScreenTUI({
      model: config.model.name,
      theme: config.tui?.theme || 'dark',
      showToolPanel: (process.stdout.columns || 80) > 120,
      onSubmit: async (input) => {
        screen.setStreaming(true);
        await runAgentLoop(input, config);
        screen.setStreaming(false);
        // Update token counter in status bar
        if (tokenTracker) screen.setTokenInfo(tokenTracker.formatShort());
      },
      onCommand: async (cmd) => {
        if (cmd === '/quit' || cmd === '/q' || cmd === '/exit') {
          if (sessionStore) sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
          screen.leave();
          killMCP();
          logEvent(EVENT_TYPES.SESSION_END, { reason: 'exit_command', mode: 'interactive' });
          process.exit(0);
        }
        // Capture command output by temporarily redirecting stdout + console.log
        const origWrite = process.stdout.write.bind(process.stdout);
        const origConsoleLog = console.log;
        let captured = '';
        process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
        console.log = (...args) => { captured += args.join(' ') + '\n'; };
        // Create a mock rl for command handler
        const mockRl = { prompt: () => {}, close: () => { screen.leave(); process.exit(0); } };
        try {
          await handleCmd(cmd, mockRl);
        } catch (e) {
          captured += `Error: ${e.message}\n`;
        }
        process.stdout.write = origWrite;
        console.log = origConsoleLog;
        if (captured.trim()) {
          // Strip ANSI codes for clean display in chat panel
          const clean = captured.replace(/\x1b\[[0-9;]*m/g, '').trim();
          screen.addChat('system', clean);
        }
        screen.render();
      },
      onExit: () => {
        // Save session before exit
        if (sessionStore) {
          sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
        }
        killMCP();
        logEvent(EVENT_TYPES.SESSION_END, { reason: 'exit_ui', mode: 'interactive' });
        process.exit(0);
      },
    });

    // Enter fullscreen FIRST (captures real stdout.write as _rawWrite)
    screen.enter();
    setFullscreenRef(screen);

    // Track current tool name for pairing stdout.write (tool start) with console.log (result)
    let _currentToolName = '';

    // Override console.log to push tool output to the screen with detail
    const origLog = console.log;
    console.log = (...args) => {
      const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!clean) return;
      // Skip turn summaries unless verbose
      if (clean.startsWith('───') && !flags.verbose) return;
      // Pair with current tool name for rich display
      if (_currentToolName) {
        const isError = clean.startsWith('✗') || clean.includes('Exit code') || clean.includes('Timed out');
        screen.addTool(_currentToolName, isError ? 'err' : 'ok', clean);
        _currentToolName = '';
      } else {
        screen.addTool('', 'ok', clean);
      }
    };

    // Override process.stdout.write — capture tool name from tui.toolStart calls
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!text) return true;
      // tui.toolStart outputs "  ⚙ toolName " — extract the tool name
      const toolMatch = text.match(/^⚙\s*(\S+)/);
      if (toolMatch) {
        _currentToolName = toolMatch[1];
      }
      return true;
    };

    return; // Event loop takes over via raw stdin
  }

  // ─── CLASSIC TUI (--classic flag) ─────────────────────────────────────
  console.log(tui.renderWelcome(config, graphOk));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/')) {
      await handleCmd(input, rl);
      return;
    }

    console.log('');
    await runAgentLoop(input, config);
    console.log('');
    console.log(tui.renderStatus(config, conversationHistory.length));
    rl.prompt();
  });

  rl.on('close', () => {
    killMCP();
    if (_lspClient) { try { _lspClient.stop(); } catch {} }
    console.log(chalk.gray('\n  Goodbye!\n'));
    logEvent(EVENT_TYPES.SESSION_END, { reason: 'exit_terminal', mode: 'interactive' });
    process.exit(0);
  });
}

function startMinimalTUI(logEvent, EVENT_TYPES, config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/')) {
      const createCommandHandler = require('../../bin/commands');
      const handleCmd = createCommandHandler(config, [], 0, null, null, 0, null, null, null);
      await handleCmd(input, rl);
      return;
    }

    console.log(chalk.gray('  No model configured. Type /provider to set up, or /exit to quit.'));
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

module.exports = {
  runTUI,
  startMinimalTUI
};
