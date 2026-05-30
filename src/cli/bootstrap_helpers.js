async function handleProviderCommand(config, positional) {
  const providerArg = positional.find(a => a === '/provider' || a === '/provider/status' || a === 'provider');
  if (providerArg) {
    const cmd = providerArg.startsWith('/') ? providerArg : '/provider';
    const rest = positional.filter(a => a !== providerArg).join(' ');
    const createCommandHandler = require('../../bin/commands');
    const handleCmd = createCommandHandler(config, [], 0, null, null, 0, null, null, null);
    const mockRl = { prompt: () => {}, close: () => {}, on: () => {}, question: (q, cb) => cb('') };
    await handleCmd(rest ? `${cmd} ${rest}` : cmd, mockRl);
    return true;
  }
  return false;
}

async function handleMissingModel(config, positional, startMinimalTUI) {
  if (!config.model.name) {
    const handled = await handleProviderCommand(config, positional);
    if (handled) return true;
    console.log('\n  ⚡ SmallCode — no model configured.\n');
    console.log('  Type /provider to configure a model, or /provider status to check.\n');
    startMinimalTUI();
    return true;
  }
  return false;
}

async function runEvalMode(flags, config, chatCompletion) {
  const { EvalRunner } = require('../../bin/eval_runner');
  const evalRunner = new EvalRunner(config);
  console.log(`\n  Running evaluation: ${flags.eval}\n`);
  const results = await evalRunner.run(flags.eval, { chatCompletionFn: chatCompletion });
  if (results.error) {
    console.log(`  \x1b[31m✗ ${results.error}\x1b[0m`);
  } else {
    console.log(EvalRunner.format(results));
    console.log('');
  }
  process.exit(results.error ? 1 : 0);
}

function initializeSession(flags, config, sessionStore, conversationHistory, improvementAttempts, logEvent, EVENT_TYPES, processCwd) {
  if (flags.resume) {
    const resumed = sessionStore.resume();
    if (resumed) {
      conversationHistory.push(...resumed.messages);
      // Clear improvement state from previous session — stale counters
      // cause false-positive patch spirals and decompose triggers.
      Object.keys(improvementAttempts).forEach(k => delete improvementAttempts[k]);
    }
  }
  if (!sessionStore.current) {
    sessionStore.create(config.model.name);
  }

  let journal = null;
  try {
    const { openJournal } = require('../../bin/memory_helpers');
    journal = openJournal(sessionStore.current.id, processCwd);
    logEvent(EVENT_TYPES.SESSION_START, { model: config.model.name, mode: flags.nonInteractive ? 'non-interactive' : 'interactive' });
  } catch (e) {
    journal = null;
  }
  return journal;
}

module.exports = {
  handleProviderCommand,
  handleMissingModel,
  runEvalMode,
  initializeSession
};
