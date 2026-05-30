// ─── RTK (Rust Token Killer) integration ─────────────────────────────────────
// Auto-rewrites supported bash commands through rtk for 60-90% token savings.
// Only activates if `rtk` binary is available on PATH.
// https://github.com/rtk-ai/rtk

let _rtkAvailable = null; // null = unchecked, true/false = cached result

function _checkRtk() {
  if (_rtkAvailable !== null) return _rtkAvailable;
  try {
    const { execSync } = require('child_process');
    execSync('rtk --version', { stdio: 'ignore', timeout: 2000 });
    _rtkAvailable = true;
  } catch {
    _rtkAvailable = false;
  }
  return _rtkAvailable;
}

// Commands RTK supports — maps regex to rtk subcommand.
// These produce significantly smaller output than raw commands.
const RTK_REWRITES = [
  // Git
  { re: /^git\s+(status|log|diff|add|commit|push|pull|fetch|branch|show)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // Test runners
  { re: /^(cargo\s+test|jest|vitest|pytest|go\s+test|npm\s+test|yarn\s+test|pnpm\s+test|rake\s+test|rspec)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // Build/lint
  { re: /^(cargo\s+build|cargo\s+clippy|tsc\b|eslint|ruff\s+check|golangci-lint|rubocop)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // File ops
  { re: /^(ls|find\s|grep\s|rg\s)/, rewrite: (cmd) => 'rtk ' + cmd },
  // Docker/k8s
  { re: /^docker\s+(ps|images|logs|compose\s+ps)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  { re: /^kubectl\s+(get\s+pods|logs|get\s+services)\b/, rewrite: (cmd) => 'rtk ' + cmd },
  // npm/pnpm/yarn list
  { re: /^(npm\s+list|pnpm\s+list|yarn\s+list)\b/, rewrite: (cmd) => 'rtk ' + cmd },
];

function rtkRewrite(command) {
  if (!_checkRtk()) return command;
  // Don't double-rewrite if already starts with rtk
  if (command.trimStart().startsWith('rtk ')) return command;
  for (const { re, rewrite } of RTK_REWRITES) {
    if (re.test(command.trimStart())) {
      return rewrite(command.trimStart());
    }
  }
  return command;
}

module.exports = { rtkRewrite };
