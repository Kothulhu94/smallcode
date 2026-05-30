'use strict';
const fs = require('fs');
const path = require('path');
const tui = require('../tui');
const chalk = tui.chalk;

async function handleTrace(ctx) {
  const { parts, rl } = ctx;
  const { TraceRecorder } = require('../trace_recorder');
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

async function handleContract(ctx) {
  const { parts, rl } = ctx;
  const { getStore } = require('../../src/session/contract_store');
  const { formatStatus, statusPayload } = require('../../src/session/contract_tools');
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

module.exports = {
  handleTrace,
  handleContract
};
