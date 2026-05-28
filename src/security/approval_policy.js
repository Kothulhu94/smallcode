// SmallCode — Command Approval Policy Governor (Runtime)
//
// Classifies shell commands into four approval tiers using safety rules
// defined in .smallcode/approval_policy.yaml. Includes support for base command
// normalization, command chaining safety (forces always_ask/blocked),
// and session trust auto-approvals.

'use strict';

const fs = require('fs');
const path = require('path');

const ACTIONS = {
  AUTO_APPROVE: 'auto_approve',
  ASK_ONCE: 'ask_once',
  AUTO_TRUSTED: 'auto_trusted',
  ALWAYS_ASK: 'always_ask',
  BLOCKED: 'blocked',
};

const DEFAULT_POLICY = {
  tier_0_auto: [
    'cat', 'ls', 'dir', 'type', 'find', 'grep', 'head', 'tail',
    'wc', 'echo', 'pwd', 'git status', 'git log', 'git diff',
    'git show', 'git branch', 'node --check', 'npm ls', 'npm outdated'
  ],
  tier_1_session_trust: [
    'npm test', 'npm run', 'node', 'git add', 'git commit', 'mkdir', 'cp', 'copy'
  ],
  tier_2_always_ask: [
    'git push', 'git pull', 'npm install', 'rm', 'del', 'rmdir'
  ],
  tier_x_blocked: [
    'format', 'fdisk', 'diskpart', 'rm -rf /', 'curl', 'wget', 'ssh', 'scp',
    'powershell -enc', 'powershell -encodedcommand'
  ]
};

class ApprovalPolicy {
  /**
   * @param {object} [config={}]
   * @param {string} [config.projectRoot] - Absolute path to project root
   * @param {string} [config.policyPath] - Absolute or relative path to YAML policy
   */
  constructor(config = {}) {
    this.projectRoot = config.projectRoot || process.cwd();
    this.policyPath = config.policyPath || path.join(this.projectRoot, '.smallcode', 'approval_policy.yaml');
    this.defaultPolicy = DEFAULT_POLICY;
    
    // Loaded policy object
    this.policy = this.loadPolicy();

    // Base commands approved this session (in-memory only)
    this.sessionTrust = new Set();
  }

  /**
   * Read and parse the policy YAML file, falling back to safe defaults if missing or malformed.
   *
   * @returns {object} The parsed or default policy lists
   */
  loadPolicy() {
    try {
      if (fs.existsSync(this.policyPath)) {
        const content = fs.readFileSync(this.policyPath, 'utf-8');
        return this.parsePolicyYaml(content);
      }
    } catch (e) {
      // Fall through to default policy
    }
    return {
      tier_0_auto: [...this.defaultPolicy.tier_0_auto],
      tier_1_session_trust: [...this.defaultPolicy.tier_1_session_trust],
      tier_2_always_ask: [...this.defaultPolicy.tier_2_always_ask],
      tier_x_blocked: [...this.defaultPolicy.tier_x_blocked],
    };
  }

  /**
   * Simple YAML line list parser. Matches top-level keys and extract item arrays.
   *
   * @param {string} content
   * @returns {object}
   */
  parsePolicyYaml(content) {
    const parsed = {};
    const lines = content.split('\n');
    let currentSection = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Match headers (e.g., tier_0_auto:)
      const headerMatch = line.match(/^([a-zA-Z0-9_]+):/);
      if (headerMatch) {
        currentSection = headerMatch[1];
        parsed[currentSection] = [];
        continue;
      }

      // Match dashes under a section (e.g., - "cat" or - cat)
      const itemMatch = line.match(/^\s*-\s*["']?([^"'\r\n]+)["']?/);
      if (itemMatch && currentSection) {
        if (!parsed[currentSection]) {
          parsed[currentSection] = [];
        }
        // Trim matching outer quotes if matching regex left them
        let value = itemMatch[1].trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        parsed[currentSection].push(value.trim());
      }
    }

    const result = {};
    const targetKeys = ['tier_0_auto', 'tier_1_session_trust', 'tier_2_always_ask', 'tier_x_blocked'];
    
    for (const key of targetKeys) {
      if (Array.isArray(parsed[key])) {
        result[key] = parsed[key];
      } else {
        result[key] = [...this.defaultPolicy[key]];
      }
    }

    return result;
  }

  /**
   * Normalize a command by stripping flags and directory segments to find the base command.
   *
   * @param {string} command
   * @returns {string} Normalized base command (e.g., "npm test", "cat", "git diff")
   */
  normalize(command) {
    if (!command) return '';

    // Split by spaces, skip flags starting with - or /
    const parts = command.trim().split(/\s+/).filter(part => {
      return !part.startsWith('-') && !part.startsWith('/');
    });

    if (parts.length === 0) return '';

    const firstWord = parts[0].toLowerCase();
    
    // Tools that commonly use multi-word actions
    const multiWordTools = [
      'git', 'npm', 'node', 'npx', 'cargo', 'go', 'bundle', 'yarn', 'pnpm', 'powershell', 'cmd'
    ];

    if (multiWordTools.includes(firstWord) && parts.length > 1) {
      const secondWord = parts[1].toLowerCase();
      return `${firstWord} ${secondWord}`;
    }

    return firstWord;
  }

  /**
   * Determine if a command contains blocked commands or patterns.
   *
   * @param {string} command
   * @returns {boolean} True if the command breaches blocklist rules
   */
  isBlocked(command) {
    const normalized = command.trim().toLowerCase();
    const words = normalized.split(/\s+/);

    for (const blockedRule of this.policy.tier_x_blocked) {
      const ruleLower = blockedRule.toLowerCase().trim();

      if (!ruleLower.includes(' ')) {
        // Single word block (e.g., "curl" should block "curl http://x")
        if (words.includes(ruleLower)) {
          return true;
        }
      } else {
        // Multi-word block (e.g., "rm -rf /")
        if (normalized.includes(ruleLower)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Classify a shell command and return its safety action.
   *
   * @param {string} command
   * @returns {object} { action, tier, reason }
   */
  classify(command) {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        action: ACTIONS.ALWAYS_ASK,
        tier: '2',
        reason: 'Empty command string',
      };
    }

    // Split by chain operators
    const segments = trimmed.split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean);

    if (segments.length > 1) {
      // 1. Chained commands safety checks
      for (const segment of segments) {
        if (this.isBlocked(segment)) {
          return {
            action: ACTIONS.BLOCKED,
            tier: 'X',
            reason: `Chained command contains a blocked segment: "${segment}"`,
          };
        }
      }

      // If no segment is blocked, chained commands default to always ask (never auto-approve)
      return {
        action: ACTIONS.ALWAYS_ASK,
        tier: '2',
        reason: 'Chained commands are not permitted for automatic execution',
      };
    }

    const singleCommand = segments[0];

    // 2. Check blocked list
    if (this.isBlocked(singleCommand)) {
      return {
        action: ACTIONS.BLOCKED,
        tier: 'X',
        reason: `Command is blocked by safety policy`,
      };
    }

    const baseCmd = this.normalize(singleCommand);

    // 3. Check Tier 0 (always auto-approve)
    if (this.policy.tier_0_auto.includes(baseCmd)) {
      return {
        action: ACTIONS.AUTO_APPROVE,
        tier: '0',
        reason: 'Command is marked for automatic approval',
      };
    }

    // 4. Check session trust (Tier 1 previously approved)
    if (this.sessionTrust.has(baseCmd)) {
      return {
        action: ACTIONS.AUTO_TRUSTED,
        tier: '1',
        reason: 'Command base was approved this session',
      };
    }

    // 5. Check Tier 1 (session trust candidate)
    if (this.policy.tier_1_session_trust.includes(baseCmd)) {
      return {
        action: ACTIONS.ASK_ONCE,
        tier: '1',
        reason: 'Requires approval once per session',
      };
    }

    // 6. Check Tier 2 (always ask)
    if (this.policy.tier_2_always_ask.includes(baseCmd)) {
      return {
        action: ACTIONS.ALWAYS_ASK,
        tier: '2',
        reason: 'Command requires confirmation on every run',
      };
    }

    // Default to Tier 2
    return {
      action: ACTIONS.ALWAYS_ASK,
      tier: '2',
      reason: 'Unrecognized command base defaults to always ask',
    };
  }

  /**
   * Approve a command for the rest of the session.
   *
   * @param {string} command
   */
  approve(command) {
    const baseCmd = this.normalize(command);
    if (baseCmd) {
      this.sessionTrust.add(baseCmd);
    }
  }

  /**
   * Reset session trust tracking.
   */
  reset() {
    this.sessionTrust.clear();
  }
}

module.exports = {
  ApprovalPolicy,
  ACTIONS,
};
