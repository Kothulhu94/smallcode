# Implementation Backlog

Prioritized task queue for enhancing the LocalAgentHarness based on patterns extracted from [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness).

**Target**: Windows ROG Ally X, KoboldCPP, Gemma 4, limited RAM  
**Constraint**: Max 500 lines per file, portable runtimes, no cloud dependencies  
**Source research**: [docs/harness_research/README.md](./README.md)

---

## Priority Legend

| Priority | Meaning | Timeline |
|----------|---------|----------|
| **P0** | Critical gap — blocks reliability or safety | Implement first |
| **P1** | High value — significant capability gain | Implement second |
| **P2** | Quality of life — polish and observability | Implement third |
| **P3** | Future — nice-to-have, can defer | Backlog |

---

## P0 — Critical (Implement First)

### P0-1: Tiered Memory Store
- **Pattern**: [01 §Pattern 1](./01_context_memory_patterns.md#pattern-1-tiered-memory-store-claude-mem--smallcode)
- **Problem**: `src/memory/evidence.js` is flat KV with no categories, no FTS, no session-spanning recall
- **New file**: `src/memory/memory_store.js` (~200 lines)
- **Dependencies**: `better-sqlite3` (npm)
- **Schema**: SQLite with FTS5 virtual table, 5 memory categories
- **Integration**: Hook into agent loop after tool results; query before prompt construction
- **Acceptance**: memories persist across sessions; keyword search returns relevant context; TTL expiry works

### P0-2: Compaction Recovery
- **Pattern**: [01 §Pattern 2](./01_context_memory_patterns.md#pattern-2-compaction-recovery-context-mode)
- **Problem**: Pruned context is permanently lost; model loses all working state
- **New file**: `src/session/event_journal.js` (~150 lines)
- **Dependencies**: none (JSONL files)
- **Integration**: Append events after each tool call; on compaction trigger, build recovery prompt
- **Acceptance**: after compaction, model knows files touched, decisions made, and plan progress

### P0-3: Sentinel Loop
- **Pattern**: [02 §Pattern 7](./02_multi_agent_orchestration.md#pattern-7-sentinel-loops-and-checkpoints-hankweave)
- **Problem**: Model gets stuck in loops or drifts off-task; no detection or intervention
- **New file**: `src/governor/sentinel_loop.js` (~180 lines)
- **Dependencies**: `quality_monitor.js`
- **Sentinels**: LoopDetector, DriftDetector, ProgressTracker, TokenBudget
- **Integration**: Run after every tool call, before next prompt
- **Acceptance**: 3x repeated tool call triggers intervention; 5 turns with no progress triggers warning

### P0-4: Verification Loop with Failure Classification
- **Pattern**: [03 §Pattern 10](./03_verification_self_healing.md#pattern-10-structured-verification-loop-with-failure-classification)
- **Problem**: No structured retry budget; no failure classification; model repeats same broken edit
- **New file**: `src/governor/verification_loop.js` (~250 lines)
- **Dependencies**: `test_runner.js`, `snapshot.js`
- **Features**: 3-retry budget, error fingerprinting, STUCK/PROGRESS/REGRESSION classification
- **Acceptance**: verification runs after each edit phase; STUCK triggers different-approach prompt

### P0-5: Approval Policy System
- **Pattern**: [05 §Pattern 16](./05_approval_gates_safety.md#pattern-16-tiered-approval-system)
- **Problem**: Binary allow/block is too coarse; no user-editable policy file
- **New file**: `src/security/approval_policy.js` (~150 lines)
- **New config**: `.smallcode/approval_policy.yaml` (~80 lines)
- **Dependencies**: `js-yaml`
- **Tiers**: 0 (auto), 1 (session-trust), 2 (always-ask), X (blocked)
- **Acceptance**: user can edit YAML to customize; session trust works; audit trail written

---

## P1 — High Value (Implement Second)

### P1-1: Plan Persistence
- **Pattern**: [01 §Pattern 3](./01_context_memory_patterns.md#pattern-3-file-based-persistent-planning-planning-with-files)
- **New file**: `src/session/plan_persistence.js` (~80 lines)
- **Modifies**: `src/session/plan_tracker.js`
- **Integration**: Save plan to `.smallcode/plans/current_plan.md`; reload on session start
- **Acceptance**: session restart picks up where previous session left off

### P1-2: Project Specs Injection
- **Pattern**: [01 §Pattern 4](./01_context_memory_patterns.md#pattern-4-project-memory-via-spec-injection-trellis)
- **New file**: `src/knowledge/project_specs.js` (~120 lines)
- **New config**: `.smallcode/project.yaml`
- **Dependencies**: `js-yaml`
- **Integration**: On each message, inject matching specs into prompt
- **Acceptance**: project conventions are always in context; domain specs injected when relevant

### P1-3: Workflow Engine
- **Pattern**: [02 §Pattern 5](./02_multi_agent_orchestration.md#pattern-5-yaml-defined-workflow-phases-archon)
- **New file**: `src/session/workflow_engine.js` (~200 lines)
- **New configs**: `.smallcode/workflows/feature_build.yaml`, `bug_fix.yaml`, `refactor.yaml`
- **Dependencies**: `js-yaml`, `plan_tracker.js`
- **Integration**: Tool filtering per phase; gate checks at phase boundaries
- **Acceptance**: multi-phase workflow restricts tools per phase; gates enforce verification

### P1-4: Task Queue
- **Pattern**: [02 §Pattern 6](./02_multi_agent_orchestration.md#pattern-6-ticket-driven-control-plane-symphony)
- **New file**: `src/session/task_queue.js` (~180 lines)
- **Directory**: `.smallcode/tasks/{queue,active,done,failed}/`
- **Integration**: Pop from queue on "next task"; inject task context on resume
- **Acceptance**: tasks survive session restarts; lifecycle tracking works

### P1-5: Observability Server + UI
- **Pattern**: [04 §Pattern 14](./04_observability_ui.md#pattern-14-agent-status-dashboard)
- **New files**:
  - `src/tui/observe_server.js` (~180 lines)
  - `src/tui/observability.html` (~300 lines)
  - `src/tui/observe_styles.css` (~150 lines)
- **Dependencies**: node `http` (built-in)
- **Integration**: 5 emit points in agent loop; SSE streaming; no external dependencies
- **Acceptance**: browser at localhost:3333 shows live plan, timeline, tokens, sentinels

### P1-6: Tool Approval Gates
- **Pattern**: [05 §Pattern 17](./05_approval_gates_safety.md#pattern-17-tool-level-approval-gates)
- **New file**: `src/security/tool_approval.js` (~120 lines)
- **Integration**: Wraps tool execution; uses read_guard for context-aware approval
- **Acceptance**: write to unread file asks for approval; read-only tools never ask

### P1-7: Checkpoint System
- **Pattern**: [03 §Pattern 11](./03_verification_self_healing.md#pattern-11-snapshot-based-auto-rollback-enhanced-from-smallcode)
- **New file**: `src/session/checkpoint.js` (~120 lines)
- **Modifies**: `src/session/snapshot.js`
- **Integration**: Checkpoint at phase boundaries; restore on exhausted retries
- **Acceptance**: phase failure rolls back to last checkpoint; checkpoint files persist for audit

---

## P2 — Quality of Life (Implement Third)

### P2-1: Session State Machine
- **Pattern**: [02 §Pattern 9](./02_multi_agent_orchestration.md#pattern-9-session-lifecycle-state-machine-chorus)
- **Modifies**: `src/session/persistence.js` (+80 lines)
- **Acceptance**: crash during compaction is detected on restart; resume offer works

### P2-2: Tool Call Repair
- **Pattern**: [03 §Pattern 13](./03_verification_self_healing.md#pattern-13-self-healing-repair-cycle)
- **New file**: `src/tools/tool_call_repair.js` (~150 lines)
- **Modifies**: `src/tools/tool_call_extractor.js`
- **Acceptance**: malformed JSON is recovered; unknown tool names are fuzzy-matched

### P2-3: DAG Visualizer
- **Pattern**: [02 §Pattern 8](./02_multi_agent_orchestration.md#pattern-8-task-dags-with-parallel-batching-open-multi-agent)
- **New file**: `src/session/dag_visualizer.js` (~80 lines)
- **Acceptance**: text-based DAG shows in observability UI and terminal

### P2-4: Command Logger
- **Pattern**: [04 §Pattern 15](./04_observability_ui.md#pattern-15-command-log-with-approval-state)
- **New file**: `src/tools/command_logger.js` (~60 lines)
- **Acceptance**: every command logged with approval state to JSONL; visible in UI

### P2-5: Approval Prompt UX
- **Pattern**: [05 §Pattern 18](./05_approval_gates_safety.md#pattern-18-approval-ux-in-terminal)
- **New file**: `src/security/approval_prompt.js` (~80 lines)
- **Acceptance**: approval prompts show tier, reason, and "approve all" option

### P2-6: Hard Safety Invariants
- **Pattern**: [05 §Pattern 19](./05_approval_gates_safety.md#pattern-19-safety-invariants-hard-rules)
- **Modifies**: `src/security/sanitize.js` (+40 lines)
- **Acceptance**: project boundary enforcement; self-modification prevention; file size limits

---

## P3 — Future (Backlog)

### P3-1: Batch Planner
- **Pattern**: [02 §Pattern 8](./02_multi_agent_orchestration.md#pattern-8-task-dags-with-parallel-batching-open-multi-agent)
- **New file**: `src/session/batch_planner.js` (~60 lines)
- **Integration**: Hint independent steps to model for single-turn batching

### P3-2: Memory CLI
- **New file**: `src/memory/memory_cli.js` (~60 lines)
- **Purpose**: `smallcode memory list`, `smallcode memory search`, `smallcode memory forget`

### P3-3: Flaky Test Registry
- **New config**: `.smallcode/flaky_tests.json`
- **Integration**: Verification loop ignores known-flaky test failures

### P3-4: Workflow YAML Library
- **New configs**: Additional workflow templates for common patterns
- **Examples**: `migration.yaml`, `documentation.yaml`, `performance_audit.yaml`

### P3-5: Multi-Agent Stub
- **Purpose**: File-based task delegation to a second agent process
- **Mechanism**: Write task file → spawn second agent process → poll for completion
- **Prerequisite**: Task Queue (P1-4) and Workflow Engine (P1-3) must be stable first

---

## Dependency Graph

```
P0-1 Memory Store ─────────────────────────────────────────┐
P0-2 Event Journal ────────────────────────────────────────┤
P0-3 Sentinel Loop ──── depends on ── quality_monitor.js   │
P0-4 Verification Loop ── depends on ── test_runner.js,    │
│                                        snapshot.js        │
P0-5 Approval Policy ─────────────────────────────────────┤
                                                           │
P1-1 Plan Persistence ── depends on ── plan_tracker.js ────┤
P1-2 Project Specs ────────────────────────────────────────┤
P1-3 Workflow Engine ── depends on ── plan_tracker.js,     │
│                                      P0-4 Verification   │
P1-4 Task Queue ───────────────────────────────────────────┤
P1-5 Observability ── depends on ── P0-3 Sentinels,       │
│                                    P0-4 Verification      │
P1-6 Tool Approval ── depends on ── P0-5 Approval Policy, │
│                                    read_guard.js          │
P1-7 Checkpoint ── depends on ── snapshot.js, P1-1 Plan    │
                                                           │
P2-* polish items ── depend on respective P0/P1 items ─────┘
```

---

## Estimated Scope

| Priority | Files | Total Lines | New Dependencies |
|----------|-------|-------------|------------------|
| P0 | 5 new + 1 config | ~930 | better-sqlite3, js-yaml |
| P1 | 7 new + 4 configs + 1 modify | ~1,250 | none additional |
| P2 | 4 new + 2 modify | ~410 | none |
| P3 | 3 new + 2 configs | ~120 | none |
| **Total** | **~19 new files** | **~2,710 lines** | **2 npm packages** |

All files stay under the 500-line limit. No file exceeds 300 lines.

---

## Implementation Order (Suggested)

```
Week 1: P0 items (foundation)
  Day 1-2: P0-1 Memory Store + P0-2 Event Journal
  Day 3:   P0-3 Sentinel Loop
  Day 4:   P0-4 Verification Loop
  Day 5:   P0-5 Approval Policy

Week 2: P1 items (capabilities)
  Day 1:   P1-1 Plan Persistence + P1-2 Project Specs
  Day 2-3: P1-3 Workflow Engine
  Day 3:   P1-4 Task Queue
  Day 4-5: P1-5 Observability Server + UI

Week 3: P1 + P2 items (polish)
  Day 1:   P1-6 Tool Approval + P1-7 Checkpoint
  Day 2-3: P2-1 through P2-6
  Day 4-5: Integration testing, edge cases, documentation
```
