# 05 — Approval Gates & Safety Rules

Patterns extracted from: **Water** (approval gates), **OmniCoreAgent** (guardrails), **Chorus** (permission model), Anthropic's "Claude Code auto mode" blog, SmallCode's existing `sanitize.js`.

---

## Current State: What SmallCode Already Does

`src/security/sanitize.js` (11KB) provides:
- Command blocklist (rm -rf /, format, etc.)
- Path traversal prevention
- Environment variable protection
- Network access restrictions (curl, wget blocked by default)

**Gaps**:
1. No tiered approval system (everything is binary: allowed or blocked)
2. No policy file the user can edit without touching code
3. No approval history/audit trail
4. No "auto-approve after N safe executions" trust escalation
5. No per-tool approval rules (only bash is gated)

---

## Pattern 16: Tiered Approval System

### Problem
Binary approval (allow/block) is too coarse. Some commands need user confirmation every time (`git push`), some can be auto-approved after the first approval in a session (`npm test`), and some should always be auto-approved (`cat`, `ls`).

### Mechanism (from Water, Anthropic's auto-mode blog)

Three approval tiers:

```
Tier 0 — ALWAYS AUTO-APPROVE (read-only, no side effects)
  cat, ls, dir, pwd, echo, head, tail, wc, grep, find, type, where
  git status, git log, git diff, git show, git branch
  node --check (syntax check)
  npm ls, npm outdated

Tier 1 — SESSION-TRUST (approve once per session, auto after)
  npm test, npm run lint, npm run build
  node <script> (in project directory)
  git add, git commit
  mkdir, cp (within project tree)
  
Tier 2 — ALWAYS ASK (every execution needs approval)
  git push, git pull, git fetch
  npm install, npm uninstall
  rm, del, rmdir
  Any command with pipes to files (> >>)
  Any command not in Tier 0 or 1

Tier X — BLOCKED (never execute)
  format, fdisk, diskpart
  rm -rf /
  Commands targeting paths outside project root
  Network commands (curl, wget, ssh) unless explicitly allowed
  PowerShell commands that modify system state
```

### What to extract (local implementation)

**File**: `src/security/approval_policy.js` (~150 lines)

```javascript
class ApprovalPolicy {
  constructor(projectRoot, policyPath) {
    this.projectRoot = projectRoot;
    this.policy = this.loadPolicy(policyPath); // .smallcode/approval_policy.yaml
    this.sessionTrust = new Map(); // commands approved this session
  }

  classify(command) {
    const normalized = command.trim().toLowerCase();
    
    // Check blocked first (highest priority)
    if (this.isBlocked(normalized)) return { tier: 'X', action: 'BLOCK' };
    
    // Check auto-approve
    if (this.isTier0(normalized)) return { tier: '0', action: 'AUTO' };
    
    // Check session trust
    const trustKey = this.getTrustKey(normalized);
    if (this.sessionTrust.has(trustKey)) return { tier: '1', action: 'AUTO_TRUSTED' };
    
    // Check Tier 1
    if (this.isTier1(normalized)) return { tier: '1', action: 'ASK_ONCE' };
    
    // Default: Tier 2
    return { tier: '2', action: 'ASK' };
  }

  approve(command) {
    const trustKey = this.getTrustKey(command);
    this.sessionTrust.set(trustKey, Date.now());
  }

  getTrustKey(command) {
    // Group commands by their base command (ignore args for trust)
    // "npm test" and "npm test -- --coverage" share trust key "npm test"
    const parts = command.trim().split(/\s+/);
    return parts.slice(0, 2).join(' ');
  }
}
```

**File**: `.smallcode/approval_policy.yaml` (user-editable)

```yaml
# Approval Policy for SmallCode Agent
# Edit this file to customize command approval behavior.
# Changes take effect immediately (reloaded per command).

tier_0_auto:
  # Read-only commands — always auto-approved
  - "cat"
  - "ls"
  - "dir"
  - "type"
  - "find"
  - "grep"
  - "head"
  - "tail"
  - "wc"
  - "echo"
  - "pwd"
  - "git status"
  - "git log"
  - "git diff"
  - "git show"
  - "git branch"
  - "node --check"
  - "npm ls"
  - "npm outdated"

tier_1_session_trust:
  # Approve once per session, then auto
  - "npm test"
  - "npm run"
  - "node"
  - "git add"
  - "git commit"
  - "mkdir"
  - "cp"
  - "copy"

tier_2_always_ask:
  # Always require approval
  - "git push"
  - "git pull"
  - "npm install"
  - "rm"
  - "del"
  - "rmdir"

blocked:
  # Never execute
  - "format"
  - "fdisk"
  - "diskpart"
  - "rm -rf /"
  - "curl"
  - "wget"
  - "ssh"
  - "scp"
  - "powershell -enc"
  - "powershell -encodedcommand"

rules:
  # Path safety: commands must target files within project root
  enforce_project_boundary: true
  project_root: "."  # relative to workspace
  
  # Network safety: block all network access by default
  allow_network: false
  
  # Max command length (prevent prompt injection via long commands)
  max_command_length: 2000
  
  # Max execution time (seconds)
  max_execution_time: 120
```

---

## Pattern 17: Tool-Level Approval Gates

### Problem
Currently only `bash` commands have safety checks. But other tools can also cause damage: `write_file` can overwrite important files, `patch` can corrupt code, `delete_file` is destructive.

### Mechanism (from Chorus, OmniCoreAgent)

Each tool gets an approval classification:

```
Tool Approval Matrix:
  ┌─────────────────┬───────────┬───────────────────────┐
  │ Tool             │ Tier      │ Condition             │
  ├─────────────────┼───────────┼───────────────────────┤
  │ read_file        │ 0 (auto)  │ always                │
  │ search           │ 0 (auto)  │ always                │
  │ graph_search     │ 0 (auto)  │ always                │
  │ list_dir         │ 0 (auto)  │ always                │
  │ patch            │ 0 (auto)  │ if file was read first│
  │ patch            │ 1 (ask)   │ if file NOT read      │
  │ write_file       │ 1 (ask)   │ new file or small     │
  │ write_file       │ 2 (ask)   │ overwriting existing  │
  │ delete_file      │ 2 (always)│ always                │
  │ bash             │ varies    │ per command policy     │
  │ web_search       │ 1 (ask)   │ if network allowed    │
  │ web_search       │ X (block) │ if network blocked    │
  └─────────────────┴───────────┴───────────────────────┘
```

This integrates with the existing `read_guard.js` — the read-before-write guard already tracks which files have been read. The enhancement is to formalize this into the approval system.

### What to extract (local implementation)

**File**: `src/security/tool_approval.js` (~120 lines)

```javascript
class ToolApproval {
  constructor(policy, readGuard) {
    this.policy = policy;
    this.readGuard = readGuard;
  }

  classifyToolCall(toolName, args) {
    switch (toolName) {
      case 'read_file':
      case 'search':
      case 'graph_search':
      case 'list_dir':
        return { action: 'AUTO', reason: 'Read-only tool' };

      case 'patch':
        if (this.readGuard.hasRead(args.file)) {
          return { action: 'AUTO', reason: 'File was read this session' };
        }
        return { action: 'ASK', reason: 'File not read yet — confirm blind edit' };

      case 'write_file':
        if (fs.existsSync(args.file)) {
          return { action: 'ASK', reason: 'Overwriting existing file' };
        }
        return { action: 'ASK_ONCE', reason: 'Creating new file' };

      case 'delete_file':
        return { action: 'ASK', reason: 'Destructive operation' };

      case 'bash':
        return this.policy.classify(args.command);

      default:
        return { action: 'ASK', reason: 'Unknown tool' };
    }
  }
}
```

---

## Pattern 18: Approval UX in Terminal

### Problem
How does the user actually approve/deny commands? Current SmallCode uses a simple Y/n prompt. This works but provides no context about *why* approval is needed.

### Mechanism (from Water, Cline)

Enhanced approval prompt:

```
┌─ APPROVAL REQUIRED ──────────────────────────────────┐
│                                                       │
│ 🔧 Tool: bash                                        │
│ 📋 Command: npm install better-sqlite3                │
│ ⚠️  Tier: 2 (always ask)                              │
│ 💡 Reason: Package installation modifies node_modules │
│                                                       │
│ Options:                                              │
│   [y] Approve this execution                          │
│   [n] Deny                                            │
│   [a] Approve all "npm install" this session          │
│   [v] View full command before deciding               │
│   [?] Why is this being asked?                        │
│                                                       │
└───────────────────────────────────────────────────────┘
```

The `[a]` option promotes the command to session trust (Tier 1 for the rest of the session).

### What to extract (local implementation)

**Modify**: `src/tools/shell_session.js` (integrate approval flow, ~30 lines)
**New helper**: `src/security/approval_prompt.js` (~80 lines)

```javascript
async function promptApproval(classification, toolName, args) {
  const { action, reason, tier } = classification;
  
  if (action === 'AUTO' || action === 'AUTO_TRUSTED') {
    // Log but don't ask
    logger.emit({ type: 'approval', tool: toolName, action, reason });
    return true;
  }
  
  if (action === 'BLOCK') {
    console.log(chalk.red(`\n❌ BLOCKED: ${reason}`));
    logger.emit({ type: 'approval', tool: toolName, action: 'BLOCKED', reason });
    return false;
  }
  
  // Show approval prompt
  console.log(chalk.yellow(`\n⚠️  APPROVAL REQUIRED`));
  console.log(`   Tool: ${toolName}`);
  console.log(`   ${formatArgs(toolName, args)}`);
  console.log(`   Tier: ${tier} | Reason: ${reason}`);
  console.log(`   [y] Approve  [n] Deny  [a] Approve all similar  [v] View details\n`);
  
  const answer = await readline.question('> ');
  
  if (answer === 'a') {
    policy.approve(args.command || toolName);
    return true;
  }
  
  return answer === 'y' || answer === 'Y';
}
```

---

## Pattern 19: Safety Invariants (Hard Rules)

### Problem
Some safety rules must NEVER be overridden, regardless of user policy or session trust. These are the "hard invariants" that prevent catastrophic damage.

### Mechanism (from all reviewed projects)

Hard invariants are enforced in code, not in policy files:

```javascript
// HARD INVARIANTS (cannot be overridden by policy)
const INVARIANTS = {
  // 1. Never execute commands targeting paths outside project root
  projectBoundary: (cmd, projectRoot) => {
    const absPath = resolveAbsolutePath(cmd);
    return absPath && absPath.startsWith(projectRoot);
  },
  
  // 2. Never delete the project root itself
  noRootDelete: (cmd) => {
    return !cmd.match(/^(rm|del|rmdir)\s+(-rf?\s+)?(\.|\.\/|\.\\)?\s*$/);
  },
  
  // 3. Never modify the safety policy file via tool call
  noSelfModify: (file) => {
    return !file.endsWith('approval_policy.yaml') && 
           !file.endsWith('sanitize.js') &&
           !file.endsWith('approval_policy.js');
  },
  
  // 4. Max file size for writes (prevent disk fill)
  maxFileSize: (content) => {
    return Buffer.byteLength(content, 'utf8') < 1_000_000; // 1MB
  },
  
  // 5. Max concurrent processes
  maxProcesses: 3,
  
  // 6. Execution timeout (hard cap)
  maxTimeout: 300_000, // 5 minutes
};
```

### What to extract (local implementation)

**Modify**: `src/security/sanitize.js` — add invariant checks as a pre-filter before the policy-based approval system. These fire first and cannot be bypassed.

---

## Summary: What to Build

| Priority | Pattern | New/Modified File | Lines | Dependencies |
|----------|---------|----------|-------|-------------|
| P0 | Approval Policy | `src/security/approval_policy.js` | ~150 | js-yaml |
| P0 | Policy YAML | `.smallcode/approval_policy.yaml` | ~80 | — |
| P1 | Tool Approval | `src/security/tool_approval.js` | ~120 | approval_policy, read_guard |
| P1 | Approval Prompt | `src/security/approval_prompt.js` | ~80 | readline |
| P2 | Hard Invariants | `src/security/sanitize.js` (modify) | +40 | — |
| P2 | Command Logger | `src/tools/command_logger.js` | ~60 | (shared with observability) |
