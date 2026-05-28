# 03 — Verification Loops & Self-Healing Patterns

Patterns extracted from: **Archon** (validation gates), **hankweave** (checkpoints), **OmniCoreAgent** (repair loops), **SmallCode** (existing snapshot/rollback), featured blog posts (Anthropic harness engineering, OpenAI harness engineering).

---

## Pattern 10: Structured Verification Loop with Failure Classification

### Problem
When a model's edit breaks tests, the current behavior is: show the error, hope the model fixes it. There's no structured retry budget, no classification of *why* it failed, and no escalation path. The model often repeats the same broken edit.

### Mechanism (synthesized from Archon, OmniCoreAgent, Anthropic's harness engineering blog)

The verification loop is a **deterministic control structure** that wraps every write phase:

```
VERIFICATION LOOP:
  max_retries: 3
  
  1. Model makes edit(s)
  2. Run verification suite:
     a. Syntax check (fast, deterministic)
     b. Lint check (fast, deterministic)  
     c. Test suite (slower, may have flaky tests)
     d. Type check if applicable
  
  3. Classify result:
     PASS        → advance to next phase
     SYNTAX_ERR  → inject error + file content, retry immediately
     LINT_ERR    → inject specific lint errors, retry
     TEST_FAIL   → classify test failure:
       - SAME_TEST_SAME_ERROR  → model is stuck, try different approach
       - SAME_TEST_NEW_ERROR   → progress, continue retry
       - NEW_TEST_FAIL         → regression, rollback + retry
       - FLAKY                 → ignore (based on flaky test registry)
     TIMEOUT     → likely infinite loop, kill + warn
  
  4. On retry:
     - Inject: "Attempt {n}/{max}. Previous error: {classified_error}"
     - If SAME_TEST_SAME_ERROR: also inject "Try a fundamentally different approach"
     - If n === max: rollback all edits in this phase, report failure
```

### What to extract (local implementation)

**File**: `src/governor/verification_loop.js` (~250 lines)

```javascript
// Core structure:
class VerificationLoop {
  constructor(config) {
    this.maxRetries = config.maxRetries || 3;
    this.checks = config.checks || ['syntax', 'lint', 'test'];
    this.errorHistory = [];  // for failure classification
  }

  async runChecks(editResult) {
    const results = [];
    
    // 1. Syntax check — parse the file, zero-cost
    if (this.checks.includes('syntax')) {
      results.push(await this.syntaxCheck(editResult.files));
    }
    
    // 2. Lint — run configured linter
    if (this.checks.includes('lint')) {
      results.push(await this.lintCheck(editResult.files));
    }
    
    // 3. Test — run test suite
    if (this.checks.includes('test')) {
      results.push(await this.testCheck());
    }
    
    return this.classifyResults(results);
  }

  classifyFailure(currentError) {
    // Compare with errorHistory to detect:
    // - Stuck loops (same error 3x)
    // - Progress (new error type)
    // - Regression (previously passing test now fails)
    const lastError = this.errorHistory[this.errorHistory.length - 1];
    if (!lastError) return 'FIRST_FAILURE';
    
    if (this.sameError(currentError, lastError)) return 'STUCK';
    if (this.isRegression(currentError)) return 'REGRESSION';
    return 'PROGRESS';
  }

  buildRetryPrompt(classification, error, attempt) {
    const base = `Verification failed (attempt ${attempt}/${this.maxRetries}):\n${error.message}`;
    
    switch (classification) {
      case 'STUCK':
        return base + '\n\n⚠️ You have made the same error before. Try a fundamentally different approach.';
      case 'REGRESSION':
        return base + '\n\n⚠️ A previously passing test now fails. Your edit may have broken something else. Consider rolling back.';
      case 'PROGRESS':
        return base + '\n\nYou fixed the previous error but introduced a new one. Keep going.';
      default:
        return base;
    }
  }
}
```

### Failure classification heuristic (no LLM needed)

```
Error fingerprint = hash(test_name + first_line_of_error_message)

STUCK:     same fingerprint appears 2+ times in errorHistory
PROGRESS:  new fingerprint, errorHistory.length > 0
REGRESSION: fingerprint matches a test that passed in the pre-edit baseline
FLAKY:     fingerprint appears in .smallcode/flaky_tests.json
```

**File**: `.smallcode/flaky_tests.json`
```json
{
  "flaky_fingerprints": [
    "a1b2c3d4",  
    "e5f6g7h8"   
  ],
  "note": "Tests that fail intermittently. Verification loop ignores these."
}
```

### What NOT to copy
- OmniCoreAgent's cloud-based error reporting
- Archon's worktree-per-attempt isolation (overkill for single model)
- Any LLM-based error classification (use deterministic fingerprinting)

### Can run locally without cloud: ✅

---

## Pattern 11: Snapshot-Based Auto-Rollback (enhanced from SmallCode)

### Problem
The existing `snapshot.js` captures pre-edit state but requires manual rollback. When the verification loop exhausts retries, rollback should be automatic.

### Mechanism (current SmallCode + enhancements from hankweave)

Current flow:
```
1. Before turn: snapshot.open()   → saves file states
2. Model edits files
3. If hard failure: snapshot.rollback()  → restores files
```

Enhanced flow:
```
1. Before phase: checkpoint.create()  → saves files + plan state + memory
2. Per-turn: snapshot.open()
3. Model edits files
4. Verification loop runs:
   - On PASS: snapshot.commit(), advance
   - On RETRY: snapshot.rollback(), retry with new prompt
   - On EXHAUSTED: checkpoint.restore(), report phase failure
5. After phase: checkpoint.archive()  → move to checkpoints/ for audit
```

The **checkpoint** is heavier than a snapshot — it captures enough state to fully resume the session from that point:

```json
// .smallcode/checkpoints/task_003/checkpoint_turn_10.json
{
  "turn": 10,
  "phase": "implement",
  "plan_state": { "current_step": 3, "steps": [...] },
  "file_states": {
    "src/auth.js": "sha256:abc123...",  // hash, not full content
    "src/routes.js": "sha256:def456..."
  },
  "file_backups": {
    "src/auth.js": ".smallcode/checkpoints/task_003/backups/auth.js.turn10"
  },
  "memory_snapshot": [...],  // recent memories
  "event_journal_offset": 42  // resume point in event journal
}
```

### What to extract (local implementation)

**Modify**: `src/session/snapshot.js` (add ~60 lines for checkpoint integration)
**New**: `src/session/checkpoint.js` (~120 lines)

### What NOT to copy
- hankweave's external checkpoint storage (we use local filesystem)
- Checkpoint diffing (unnecessary complexity at our scale)

### Can run locally without cloud: ✅

---

## Pattern 12: Test/Check Gates with Progressive Strictness

### Problem
Running the full test suite after every edit is slow and wasteful. But skipping tests entirely lets regressions accumulate.

### Mechanism (synthesized from Archon, Anthropic blog)

**Progressive strictness** means running cheaper checks first and only running expensive checks at phase boundaries:

```
Per-edit (< 1 second):
  - Syntax parse of edited file only
  - Basic lint of edited file only

Per-phase-gate (may take 10+ seconds):
  - Full lint run
  - Full test suite
  - Type check (if applicable)

Per-task-completion:
  - Full test suite
  - Git diff review prompt
  - User approval gate
```

This is implemented as configuration in the workflow YAML:

```yaml
phases:
  - name: implement
    checks:
      per_edit: [syntax]
      per_gate: [lint, test]
    gate:
      type: all_pass
      retry: 3
      
  - name: verify
    checks:
      per_gate: [lint, test, diff_review]
    gate:
      type: user_approval
```

### What to extract (local implementation)

**Integrated into**: `src/governor/verification_loop.js`

The verification loop reads the current phase's `checks` configuration and runs only the appropriate level:

```javascript
// Called after each edit:
async postEditCheck(file) {
  const phase = this.workflow.currentPhase();
  const checks = phase.checks?.per_edit || [];
  // Only run lightweight checks
  return this.runChecks(checks, [file]);
}

// Called at phase boundary:
async gateCheck() {
  const phase = this.workflow.currentPhase();
  const checks = phase.checks?.per_gate || ['test'];
  return this.runChecks(checks, null); // all files
}
```

### What NOT to copy
- Heavy CI/CD integration (we run locally)
- Parallelized test execution (single machine, limited RAM)

### Can run locally without cloud: ✅

---

## Pattern 13: Self-Healing Repair Cycle

### Problem
When the model produces invalid JSON for a tool call, or a tool call that doesn't match any schema, the agent loop currently either crashes or sends the raw error back. The model then often produces another invalid call.

### Mechanism (from SmallCode's compiled features + OmniCoreAgent)

SmallCode already has a `repair_tool_call` compiled feature in `src/compiled/features/`. The pattern to formalize:

```
Tool Call Repair Cycle:
  1. Model emits tool call
  2. Parse JSON → if valid, execute
  3. If invalid JSON:
     a. Try regex extraction (find JSON-like blocks in output)
     b. Try bracket balancing (add missing closing braces)
     c. Try key-quoting (fix unquoted keys)
     d. If all fail → ask model to "fix this tool call" (1 extra turn)
  4. If valid JSON but unknown tool:
     a. Fuzzy match tool name against known tools
     b. If match confidence > 0.8 → use matched tool
     c. Else → inject "Available tools are: ..." and retry
  5. If valid JSON, known tool, but invalid args:
     a. Inject schema + error message
     b. Retry (counts against verification budget)
```

### What to extract (local implementation)

**File**: `src/tools/tool_call_repair.js` (~150 lines)

This formalizes what's scattered across `tool_call_extractor.js` and the compiled features:

```javascript
class ToolCallRepair {
  constructor(toolSchemas) {
    this.schemas = toolSchemas;
    this.repairAttempts = 0;
    this.maxRepairs = 2; // per turn
  }

  repair(rawOutput) {
    // Stage 1: JSON extraction
    let parsed = this.tryJsonParse(rawOutput);
    if (!parsed) parsed = this.regexExtract(rawOutput);
    if (!parsed) parsed = this.bracketBalance(rawOutput);
    if (!parsed) return { success: false, type: 'JSON_UNFIXABLE' };

    // Stage 2: Tool name resolution
    const tool = this.resolveToolName(parsed.tool || parsed.name);
    if (!tool) return { success: false, type: 'UNKNOWN_TOOL', suggestion: this.fuzzyMatch(parsed.tool) };

    // Stage 3: Argument validation
    const argErrors = this.validateArgs(tool, parsed.args || parsed.arguments);
    if (argErrors.length > 0) return { success: false, type: 'INVALID_ARGS', errors: argErrors };

    return { success: true, tool, args: parsed.args };
  }
}
```

### What NOT to copy
- LLM-based repair (expensive, and the heuristic version works well enough)
- Cloud fallback for unfixable calls (we handle locally)

### Can run locally without cloud: ✅

---

## Summary: What to Build

| Priority | Pattern | New/Modified File | Lines | Dependencies |
|----------|---------|----------|-------|-------------|
| P0 | Verification Loop | `src/governor/verification_loop.js` | ~250 | test_runner.js, snapshot.js |
| P0 | Failure Classification | (part of verification_loop.js) | — | — |
| P1 | Checkpoint System | `src/session/checkpoint.js` | ~120 | snapshot.js, plan_tracker.js |
| P1 | Tool Call Repair | `src/tools/tool_call_repair.js` | ~150 | tool_call_extractor.js |
| P2 | Flaky Test Registry | `.smallcode/flaky_tests.json` | config | verification_loop.js |
| P2 | Progressive Check Config | (part of workflow YAML) | — | workflow_engine.js |
