'use strict';
const fs = require('fs');
const path = require('path');
const tui = require('../tui');
const chalk = tui.chalk;

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

module.exports = {
  handlePlugin,
  handleSkill
};
