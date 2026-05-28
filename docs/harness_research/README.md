# Harness Research Index

Research extracted from [Picrew/awesome-agent-harness](https://github.com/Picrew/awesome-agent-harness) — filtered for patterns implementable on a **Windows ROG Ally X + KoboldCPP + Gemma 4** local stack.

**Date**: 2026-05-28  
**Source repository**: 223 entries across 9 categories  
**Selected for deep analysis**: 13 projects  
**Selection criteria**: Extractable local patterns, no cloud lock-in, small-model friendly

---

## Navigation

| Document | Focus Area |
|---|---|
| [01 — Context & Memory Patterns](./01_context_memory_patterns.md) | Pruning, injection, session recovery, compaction |
| [02 — Multi-Agent Orchestration](./02_multi_agent_orchestration.md) | File-based tasks, state machines, worktrees |
| [03 — Verification & Self-Healing](./03_verification_self_healing.md) | Repair loops, test gates, failure classification |
| [04 — Observability UI](./04_observability_ui.md) | Prompts, tool calls, token metrics, task state |
| [05 — Approval Gates & Safety](./05_approval_gates_safety.md) | Command execution safety, permission models |
| [Implementation Backlog](./implementation_backlog.md) | Prioritized task queue with file targets |

---

## Selected Projects (13)

| # | Project | Category | Why Selected |
|---|---------|----------|--------------|
| 1 | **claude-mem** | Context/Memory | Session capture + reinjection across compactions |
| 2 | **Context Mode** | Context/Memory | MCP context server, event indexing, compaction recovery |
| 3 | **planning-with-files** | Context/Orchestration | File-based persistent planning for coding workflows |
| 4 | **Trellis** | Context/Workflow | Task context, project memory, spec injection |
| 5 | **Archon** | Orchestration | YAML workflow phases, worktree isolation, validation gates |
| 6 | **Symphony** | Orchestration | Ticket-driven control plane, isolated implementation runs |
| 7 | **Chorus** | Orchestration/Observability | Session lifecycle, task state, sub-agent orchestration, recovery |
| 8 | **hankweave** | Orchestration | Sentinels, checkpoint loops, event journals for long runs |
| 9 | **VoltAgent** | Observability | TypeScript runtime with observability console |
| 10 | **OmniCoreAgent** | Full Harness | Model loop, tools, MCP, memory, guardrails, events, REST/SSE |
| 11 | **Water** | Safety/Orchestration | Approval gates, resilience, guardrails, sandboxing |
| 12 | **Hive** | Orchestration | Outcome-driven runtime with explicit control loops |
| 13 | **Open Multi-Agent** | Orchestration | Task DAGs, parallel execution, live tracing |

---

## What We Already Have (SmallCode baseline)

Before adopting anything new, we inventoried the existing codebase:

| Capability | Existing Module | Status |
|---|---|---|
| Tool routing | `src/session/action_classifier.js` | ✅ Working (regex-weighted) |
| Plan tracking | `src/session/plan_tracker.js` | ✅ Working |
| Dependency graph | `src/session/dependency_graph.js` | ✅ Working |
| Parallel executor | `src/session/parallel_executor.js` | ✅ Wired, not default |
| Snapshot/rollback | `src/session/snapshot.js` | ✅ Working |
| Session persistence | `src/session/persistence.js` | ✅ Atomic writes |
| Read-before-write guard | `src/session/read_guard.js` | ✅ Working |
| Token counting | `src/session/tokens.js` | ✅ Basic |
| Memory evidence | `src/memory/evidence.js` | ⚠️ Minimal — no FTS, no categories |
| Quality monitor | `src/governor/quality_monitor.js` | ⚠️ Basic quality scoring |
| Early stop | `src/governor/early_stop.js` | ⚠️ Basic |
| Command sanitization | `src/security/sanitize.js` | ✅ Working |
| Test runner | `src/tools/test_runner.js` | ✅ Working |
| Trust decay | `src/tools/trust_decay.js` | ✅ Trust scoring |
| Two-stage routing | `src/tools/two_stage_router.js` | ✅ For <16k contexts |

**Key gaps** (these are what the research targets):
1. No structured long-term memory with categories, FTS, and session-spanning recall
2. No multi-agent orchestration — single-agent loop only
3. No observability UI — all diagnostics are console logs
4. No formalized approval gate system beyond sanitize.js
5. No compaction recovery — when context is pruned, it's lost
6. No verification loop with failure classification and retry budget
