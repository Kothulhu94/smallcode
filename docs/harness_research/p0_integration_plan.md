# Integration Plan: P0 Harness Modules

This document outlines the design and plan to integrate the five completed P0 modules into the main `LocalAgentHarness` runtime loops (`bin/smallcode.js` and `src/api/index.js`) and tool layers.

## 1. Wiring Targets

| Module | Core Responsibility | Primary Wiring Target | Description |
|---|---|---|---|
| **P0-1 Memory Store** | Persistent structured SQLite recall | `bin/smallcode.js`, `src/api/index.js` | Replaces/upgrades the JSON fallback memory store. Integrates FTS5/LIKE search. |
| **P0-2 Event Journal** | Append-only JSONL session logging | `bin/smallcode.js`, `src/api/index.js` | Logs all tool calls, results, and decisions. Builds recovery prompts on compaction. |
| **P0-3 Sentinel Loop** | Guard rails against loop/drift/overrun | `bin/smallcode.js`, `src/api/index.js` | Intervenes during turns on loop, drift, budget warning, or stall. |
| **P0-4 Verification Loop** | Self-healing retry loops & rollback | `bin/smallcode.js`, `src/api/index.js` | Integrates with `snapshot.js` and `test_runner.js` to verify edits and auto-rollback. |
| **P0-5 Approval Policy** | Command authorization tiers | `src/tools/shell_session.js` | Intercepts commands in the shell to enforce YAML safety policies. |

---

## 2. Passive vs. Active Division

### Passive Instrumentation
These components monitor execution without blocking, reverting, or modifying tool paths. They pose very low risk because failures can be caught and bypassed.
- **Event Journal**: Write-only logging of agent events. Builds summaries on compaction.
- **Memory Store**: Standard DB updates and query logging.

### Active Control
These components intercept execution, inject system messages, reject user commands, or roll back file changes. They alter runtime behavior and require rigorous test coverage.
- **Approval Policy**: Intercepts and blocks/prompts for shell commands.
- **Sentinel Loop**: Injects instructions or halts agent loop on resource/pattern warnings.
- **Verification Loop**: Reverts edits and controls retry iteration cycles.

---

## 3. Safest Integration Order

The integration will follow a four-step phased rollout starting from the lowest-risk passive logging to the highest-risk execution rollback.

### Step 1: Event Journal Logging (Passive)
- **Files Modified**:
  - [bin/smallcode.js](file:///d:/LocalAgentHarness/bin/smallcode.js)
  - [src/api/index.js](file:///d:/LocalAgentHarness/src/api/index.js)
- **Behavior Added**: Initialize an `EventJournal` instance with the session ID. Append records on `tool_start`, `tool_end`, planning decisions, and error events.
- **Tests Needed**: Integration tests verifying that running a simple session writes valid JSONL lines to `.smallcode/sessions/{sessionId}/events.jsonl`.
- **Rollback Risk**: Very Low. The journaling operations can be wrapped in a global try-catch block; if disk writes fail, the main agent loop continues unimpeded.
- **Changes Runtime Behavior**: No.

### Step 2: Tiered Memory Store Migration (Passive)
- **Files Modified**:
  - [bin/smallcode.js](file:///d:/LocalAgentHarness/bin/smallcode.js)
  - [src/api/index.js](file:///d:/LocalAgentHarness/src/api/index.js)
  - [bin/memory.js](file:///d:/LocalAgentHarness/bin/memory.js)
- **Behavior Added**: Replaces the JSON fallback in `MemoryStore` with `src/memory/memory_store.js`. Directs memory tools (`memory_load`, `memory_remember`) to use the SQLite backend.
- **Tests Needed**: Verify that database files (`memory.db`) are created dynamically, and the `memory_remember`/`memory_load` tool actions function correctly.
- **Rollback Risk**: Low. SQLite schema migration is isolated; a fallback to the old JSON mechanism is trivial to restore if SQLite locks occur.
- **Changes Runtime Behavior**: No.

### Step 3: Shell Session Approval Policy (Active)
- **Files Modified**:
  - [src/tools/shell_session.js](file:///d:/LocalAgentHarness/src/tools/shell_session.js)
- **Behavior Added**: Load `ApprovalPolicy` at shell start. In `ShellSession.run()`, classify the command. Auto-approve Tier 0, ask user via terminal prompt for Tier 1 & 2, and reject Tier X commands outright.
- **Tests Needed**: Unit tests mocking stdin for approvals; E2E tests validating that a blocked command (e.g. `curl`) is rejected.
- **Rollback Risk**: Medium. If the classification is too strict or the interactive prompt hangs, execution gets stuck. A bypass environment variable can be provided.
- **Changes Runtime Behavior**: Yes.

### Step 4: Sentinel and Verification Loops (Active)
- **Files Modified**:
  - [bin/smallcode.js](file:///d:/LocalAgentHarness/bin/smallcode.js)
  - [src/api/index.js](file:///d:/LocalAgentHarness/src/api/index.js)
- **Behavior Added**:
  - Sentinel check runs after each tool call. Halts or injects prompt alerts on drift or budget exhaustion.
  - Verification loop wraps the post-edit test phase. Runs discovered tests up to 3 times, finger-prints errors, and triggers `SnapshotManager.rollback()` on regressions or retry exhaustion.
- **Tests Needed**: Regression tests forcing 3 failures to verify rollback; tests injecting duplicate tool calls to verify Sentinel Loop intervention.
- **Rollback Risk**: High. Auto-rollback deletes files and changes prompts; logic bugs could cause accidental work loss or infinite loops.
- **Changes Runtime Behavior**: Yes.

---

## 4. Recommended First Step: Event Journal Logging

We recommend beginning with **Step 1: Event Journal Logging**.

### Why it is Lowest Risk:
1. **Passive Nature**: Journaling is strictly passive (read/write only). It does not mutate command executions, file structures, or LLM prompts.
2. **Isolation**: A failure in the logging system (e.g., file system locks or bad JSON serialization) can be safely caught using a simple try-catch block, resulting in zero execution impact.
3. **Foundation**: The event journal acts as the data foundation for future compaction recovery (re-syncing state after token limits are pruned) and observability dashboard streams.
