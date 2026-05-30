'use strict';
const fs = require('fs');
const path = require('path');
const tui = require('../tui');
const chalk = tui.chalk;

async function handleSession(ctx) {
  const { parts, conversationHistory, rl } = ctx;
  const { MultiSessionManager } = require('../../src/session/multi');
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
  const { SessionStore } = require('../../src/session/persistence');
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

module.exports = {
  handleSession,
  handleSessions
};
