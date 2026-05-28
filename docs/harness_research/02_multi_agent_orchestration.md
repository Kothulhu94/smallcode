# 02 — Multi-Agent Orchestration Patterns

Patterns extracted from: **Archon**, **Symphony**, **Chorus**, **hankweave**, **Open Multi-Agent**, **Hive**.

---

## Pattern 5: YAML-Defined Workflow Phases (Archon)

### Problem
Complex tasks (refactors, migrations, feature builds) need structured phases: analyze → plan → implement → verify. Without explicit phases, small models skip verification or start implementing before understanding the codebase.

### Mechanism
Archon defines workflows as YAML files with **phases**, **gates**, and **validation steps**:

```yaml
# .smallcode/workflows/feature_build.yaml
name: feature_build
description: "Build a new feature with verification"

phases:
  - name: analyze
    tools: [read_file, search, graph_search]
    max_turns: 5
    gate:
      type: checkpoint
      condition: "model has read all relevant files"
      
  - name: plan
    tools: [read_file, respond]
    max_turns: 3
    output: plan  # captures plan for tracker
    gate:
      type: user_approval
      prompt: "Review this plan before I start implementing"
      
  - name: implement
    tools: [patch, write_file, bash]
    max_turns: 20
    gate:
      type: test_pass
      command: "npm test"
      retry: 3
      
  - name: verify
    tools: [read_file, bash, search]
    max_turns: 5
    validation:
      - type: lint
        command: "npm run lint"
      - type: test
        command: "npm test"
      - type: diff_review
        action: "show git diff for user review"
```

### What to extract (local implementation)

**File**: `src/session/workflow_engine.js` (~200 lines)

The engine is a simple state machine:
```
State: { current_phase, turn_count, phase_results }

On each model turn:
  1. Check if current_phase.max_turns exceeded → advance or fail
  2. Filter available tools to current_phase.tools
  3. After tool execution, check gate conditions
  4. If gate passes → advance to next phase
  5. If gate fails → retry or halt for user input
```

**Key simplification for our use case**: Archon uses worktree isolation (git worktrees) for parallel agent runs. We don't need this for single-agent, but we should support the **phase/gate structure** because it prevents small models from skipping verification.

**Built-in workflows to ship**:
- `feature_build.yaml` — analyze → plan → implement → verify
- `bug_fix.yaml` — reproduce → diagnose → fix → verify
- `refactor.yaml` — analyze → plan → implement → verify → cleanup

### What NOT to copy
- Git worktree isolation (complex, Windows edge cases, single-agent doesn't need it)
- Archon's YAML-to-code compilation step (our YAML is interpreted at runtime)
- Cloud-backed phase state persistence (our state is local JSON)

### Can run locally without cloud: ✅

---

## Pattern 6: Ticket-Driven Control Plane (Symphony)

### Problem
When running multiple tasks or switching between contexts, the agent needs a way to track what's been assigned, what's in progress, and what's done — without relying on conversation history.

### Mechanism
Symphony treats a **ticket tracker** (in their case, GitHub Issues) as the control plane:

```
Ticket Lifecycle:
  OPEN → ASSIGNED → IN_PROGRESS → VERIFICATION → DONE / FAILED

Each ticket contains:
  - Title and description (the task)
  - Assigned agent (or "local")
  - Status
  - Implementation log (appended after each phase)
  - Files touched
  - Verification results
```

For our local use case, tickets are **JSON files in a queue directory**:

```
.smallcode/tasks/
  queue/
    001_add_memory_store.json
    002_fix_auth_bug.json
  active/
    003_refactor_tools.json
  done/
    000_setup_project.json
  failed/
```

### What to extract (local implementation)

**File**: `src/session/task_queue.js` (~180 lines)

```json
// Task file schema:
{
  "id": "003",
  "title": "Refactor tools directory",
  "description": "Split shell_session.js into shell_executor.js and shell_sanitizer.js",
  "status": "in_progress",
  "workflow": "refactor",
  "phase": "implement",
  "created_at": "2026-05-28T03:25:00Z",
  "started_at": "2026-05-28T03:30:00Z",
  "files_touched": ["src/tools/shell_session.js"],
  "decisions": ["Keep the PTY session pool in shell_executor.js"],
  "verification": null,
  "log": [
    {"t": "2026-05-28T03:30:00Z", "event": "phase_start", "phase": "analyze"},
    {"t": "2026-05-28T03:32:00Z", "event": "phase_complete", "phase": "analyze"},
    {"t": "2026-05-28T03:32:01Z", "event": "phase_start", "phase": "implement"}
  ]
}
```

**Integration points**:
- On session start: check `active/` for resumed tasks, inject task context
- When user says "next task": pop from `queue/`, move to `active/`
- When workflow completes: move to `done/` with verification results
- On failure after retries: move to `failed/` with error log

### What NOT to copy
- Symphony's GitHub Issues integration (we're local-only)
- Cloud-based agent assignment (single agent)
- Webhook-driven status updates

### Can run locally without cloud: ✅

---

## Pattern 7: Sentinel Loops and Checkpoints (hankweave)

### Problem
Long-running tasks (20+ turns) on small models tend to drift or get stuck in loops. The model repeats the same failed edit, or wanders off-task. Without external supervision, the agent burns tokens without progress.

### Mechanism
hankweave implements **sentinels** — lightweight monitors that run after each agent turn and can intervene:

```
Sentinel Types:
  1. Loop detector    — detects repeated tool calls with same args (3x = intervention)
  2. Drift detector   — compares current action to plan; flags if unrelated
  3. Progress tracker  — measures "meaningful output" per N turns; halts if zero
  4. Cost sentinel    — tracks cumulative tokens; warns at budget thresholds
  5. Time sentinel    — wall-clock timeout per task
```

Each sentinel produces a **verdict**: `continue`, `warn`, `intervene`, `halt`.

On `warn`: inject a system message ("You seem to be repeating the same edit. Try a different approach.")
On `intervene`: reset the model's tool state, re-inject the plan, force a re-read of the target file.
On `halt`: stop the task, save state for manual review.

**Checkpoints** are snapshots taken at sentinel boundaries:
```
.smallcode/checkpoints/
  task_003/
    checkpoint_turn_05.json  ← full state: plan, files, history summary
    checkpoint_turn_10.json
    checkpoint_turn_15.json
```

On resume after a halt, the last checkpoint is loaded instead of replaying the full history.

### What to extract (local implementation)

**File**: `src/governor/sentinel_loop.js` (~180 lines)

```javascript
// Sentinel interface:
// {
//   name: string,
//   check(turnState): { verdict: 'continue'|'warn'|'intervene'|'halt', message?: string }
// }

// Built-in sentinels:
// 1. LoopDetector — hash last 3 tool calls, detect repeats
//    Implementation: rolling window of {tool, argsHash} tuples
//    Threshold: 3 identical calls = intervene

// 2. DriftDetector — compare current file targets vs plan files
//    Implementation: if model writes to file not in plan, warn
//    If 3 consecutive unplanned writes, intervene

// 3. ProgressTracker — count "meaningful outputs" per 5 turns
//    Meaningful = successful file write, test pass, plan step advance
//    If 5 turns with zero meaningful outputs, intervene

// 4. TokenBudget — track cumulative prompt+completion tokens
//    Warn at 70% of configured budget, halt at 100%
```

**Integration**: runs after every tool call in the main agent loop, before sending the next prompt.

### What NOT to copy
- hankweave's external orchestration layer (we're modifying the inner loop)
- Event journal publishing to external systems
- Multi-harness coordination

### Can run locally without cloud: ✅

---

## Pattern 8: Task DAGs with Parallel Batching (Open Multi-Agent)

### Problem
The existing `dependency_graph.js` builds a dependency graph from plan steps, but it's not connected to an executor that can actually batch independent steps.

### Mechanism
Open Multi-Agent turns a goal into a **task DAG** (Directed Acyclic Graph):

```
Goal: "Add auth with refresh tokens"
           │
    ┌──────┴──────┐
    │             │
  Read auth     Read routes
    │             │
    └──────┬──────┘
           │
      Create plan
           │
    ┌──────┴──────┐
    │             │
  Write auth   Write routes  ← parallel batch (independent files)
    │             │
    └──────┬──────┘
           │
       Run tests
```

For a **single-agent local setup**, true parallelism isn't useful (one model, one context). But the DAG is valuable for:
1. **Ordering** — ensures reads happen before writes
2. **Batching tool calls** — when two writes are independent, the model can emit both in one turn
3. **Progress visualization** — shows the user what's done and what's next

### What to extract (local implementation)

This is mostly already in `src/session/dependency_graph.js`. The enhancement is:

**File**: `src/session/dag_visualizer.js` (~80 lines)

```
Output a text-based DAG for the observability UI:

  ✓ Read auth.js
  ✓ Read routes.js
  → Write auth.js (in progress)
  ○ Write routes.js (blocked by: Write auth.js — same file? No, independent)
  ○ Run tests (blocked by: all writes)
```

**File**: `src/session/batch_planner.js` (~60 lines)

Given the DAG, identify which pending steps can be batched into a single model turn. Inject a hint:

```
You can perform these steps in parallel (they touch different files):
- Write the refresh handler to src/auth.js
- Add the refresh route to src/routes.js
```

### What NOT to copy
- Open Multi-Agent's multi-agent routing (we're single-agent)
- MCP integration layer
- Live tracing dashboard (we build our own lighter version)

### Can run locally without cloud: ✅

---

## Pattern 9: Session Lifecycle State Machine (Chorus)

### Problem
Sessions have complex lifecycles: start → active → compacting → recovering → paused → resumed → completed. Without explicit state management, edge cases (power loss mid-edit, crash during compaction) corrupt state.

### Mechanism
Chorus models the session as a finite state machine:

```
                    ┌─────────┐
                    │  INIT   │
                    └────┬────┘
                         │ load/create
                    ┌────▼────┐
              ┌────►│ ACTIVE  │◄────┐
              │     └────┬────┘     │
              │          │          │
         resume     compact    recover
              │          │          │
              │     ┌────▼─────┐   │
              │     │COMPACTING│───┘
              │     └────┬─────┘
              │          │ complete
              │     ┌────▼────┐
              └─────│ PAUSED  │
                    └────┬────┘
                         │ end
                    ┌────▼─────┐
                    │COMPLETED │
                    └──────────┘
```

Each state transition:
1. Writes the new state to disk **before** acting
2. On startup, reads the last state from disk and decides recovery action
3. If state is `COMPACTING` on startup → compaction crashed → re-run recovery
4. If state is `ACTIVE` on startup → previous session didn't clean up → offer resume

### What to extract (local implementation)

**Modify**: `src/session/persistence.js` (add ~80 lines for state machine)

```javascript
// Session state file: .smallcode/sessions/{id}/state.json
// {
//   "status": "active",
//   "last_turn": 12,
//   "last_checkpoint": "checkpoint_turn_10.json",
//   "compaction_count": 1,
//   "started_at": "...",
//   "updated_at": "..."
// }

// On session load:
// 1. Read state.json
// 2. If status === "compacting" → recovery needed, run compaction recovery
// 3. If status === "active" → offer resume with last checkpoint
// 4. If status === "paused" → offer resume or new session
```

### What NOT to copy
- Chorus' sub-agent orchestration (future work, not MVP)
- AIDLC permission model (overengineered for single-user)
- Matrix room integration

### Can run locally without cloud: ✅

---

## Summary: What to Build

| Priority | Pattern | New/Modified File | Lines | Dependencies |
|----------|---------|----------|-------|-------------|
| P0 | Sentinel Loop | `src/governor/sentinel_loop.js` | ~180 | quality_monitor.js |
| P1 | Workflow Engine | `src/session/workflow_engine.js` | ~200 | plan_tracker.js |
| P1 | Task Queue | `src/session/task_queue.js` | ~180 | none |
| P2 | Session State Machine | `src/session/persistence.js` (modify) | +80 | none |
| P2 | DAG Visualizer | `src/session/dag_visualizer.js` | ~80 | dependency_graph.js |
| P3 | Batch Planner | `src/session/batch_planner.js` | ~60 | dependency_graph.js |
| P3 | Workflow YAML files | `.smallcode/workflows/*.yaml` | ~50 each | workflow_engine.js |
