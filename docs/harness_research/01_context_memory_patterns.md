# 01 — Context, Memory & Session Recovery Patterns

Patterns extracted from: **claude-mem**, **Context Mode**, **planning-with-files**, **Trellis**, SmallCode internals.

---

## Pattern 1: Tiered Memory Store (claude-mem + SmallCode)

### Problem
Small models forget everything between sessions. Even within a session, context pruning under token pressure destroys working state. The current `evidence.js` is a flat key-value store with no categories, no full-text search, and no automatic recall.

### Mechanism
**claude-mem** implements a plugin-style memory layer that:
1. **Captures** — hooks into tool call results and model outputs, extracting "memory-worthy" items via keyword triggers (decision, convention, gotcha, workflow, context)
2. **Stores** — persists to a SQLite database with FTS5 full-text search, categorized by type
3. **Recalls** — on each new message, runs keyword overlap between the user's message and stored memories, injecting the top-N as a system message prefix
4. **Expires** — TTL-based decay so stale memories don't pollute the context window

### What to extract (local implementation)

**File**: `src/memory/memory_store.js` (~200 lines)

```
Schema:
  memories table:
    id          TEXT PRIMARY KEY (uuid)
    category    TEXT (decision | convention | gotcha | workflow | context)
    content     TEXT
    keywords    TEXT (comma-separated, for FTS)
    created_at  INTEGER (unix epoch)
    last_used   INTEGER (unix epoch)
    use_count   INTEGER DEFAULT 0
    ttl_days    INTEGER DEFAULT 30
    session_id  TEXT

  FTS virtual table:
    memories_fts USING fts5(content, keywords, content=memories)
```

**Recall algorithm** (zero-LLM-call):
```
1. Tokenize user message → extract nouns/verbs (simple regex, no NLP)
2. Query FTS: SELECT * FROM memories_fts WHERE memories_fts MATCH ?
3. Rank by: (relevance_score * 0.6) + (recency_score * 0.3) + (use_count * 0.1)
4. Take top 5, inject as:
   REMEMBERED CONTEXT:
   - [decision] We use patch-first editing, not whole-file rewrites
   - [gotcha] The auth module has circular imports if you add a direct require
5. Bump last_used and use_count for injected memories
```

### What NOT to copy
- claude-mem's cloud sync layer
- Embedding-based semantic search (requires a second model; keyword FTS is sufficient for our context)
- Any MCP server wrapper — we inject directly into the prompt

### Can run locally without cloud: ✅
SQLite ships everywhere. `better-sqlite3` is already a common Node dependency.

---

## Pattern 2: Compaction Recovery (Context Mode)

### Problem
When the context window fills up, the harness must prune old messages. After pruning, the model loses track of what files it read, what decisions were made, and what the current plan is. Context Mode calls this the "compaction boundary" problem.

### Mechanism
Context Mode maintains an **event index** — a lightweight log of every significant action the agent took, stored outside the conversation history:

```json
{
  "events": [
    {"t": 1716854400, "type": "file_read",    "path": "src/auth.js", "summary": "JWT validation, 340 lines"},
    {"t": 1716854460, "type": "file_write",   "path": "src/auth.js", "patch": "Added refreshToken()"},
    {"t": 1716854520, "type": "decision",     "content": "Use HS256 for local tokens"},
    {"t": 1716854580, "type": "tool_result",  "tool": "bash", "summary": "Tests pass: 14/14"},
    {"t": 1716854640, "type": "plan_step",    "step": 3, "status": "done"}
  ]
}
```

When compaction happens:
1. The pruned messages are summarized into a **compaction summary** (one LLM call, or regex extraction of key facts)
2. The event index is filtered to the last N events + all decisions + current plan state
3. A **recovery prompt** is injected:

```
SESSION RECOVERY (context was compacted at turn 12):
- Files touched: src/auth.js (read+write), src/routes.js (read)
- Decisions made: Use HS256 for local tokens; patch-first editing
- Current plan: Step 3 of 5 complete (see ACTIVE PLAN above)
- Last tool output: Tests pass 14/14
```

### What to extract (local implementation)

**File**: `src/session/event_journal.js` (~150 lines)

```javascript
// Append-only JSONL file: .smallcode/sessions/{id}/events.jsonl
// One line per event, flushed after each tool call

// On compaction trigger (called by tokens.js when usage > 80%):
// 1. Read events.jsonl
// 2. Build recovery prompt from: last 20 events + all "decision" events + plan state
// 3. Inject as first system message after compaction
// 4. Archive compacted events to events.compacted.jsonl
```

### What NOT to copy
- Context Mode's MCP server architecture (overkill for single-agent)
- Session event indexing via external database (JSONL is sufficient at our scale)
- Sandboxed tool output storage (we trust our own tool outputs)

### Can run locally without cloud: ✅
Plain JSONL files. No dependencies.

---

## Pattern 3: File-Based Persistent Planning (planning-with-files)

### Problem
Plans created by the model exist only in the conversation history. After a session restart or compaction, the plan is gone. The model starts from scratch, duplicating or contradicting previous work.

### Mechanism
planning-with-files persists plans as **markdown files in the project workspace**:

```
.smallcode/
  plans/
    current_plan.md       ← active plan, machine-readable
    plan_history/
      2026-05-28T03_25.md ← archived plans
```

The plan file format:
```markdown
# Plan: Add refresh token support

## Status: IN_PROGRESS (step 3/5)

## Steps
- [x] 1. Read the existing auth module — `src/auth.js`
- [x] 2. Identify the JWT validation function — `validateToken()`
- [ ] 3. Add the refresh token handler — target: `src/auth.js`
- [ ] 4. Update the route middleware — target: `src/routes.js`
- [ ] 5. Run tests — command: `npm test`

## Decisions
- Use HS256 for local tokens (consistent with existing code)
- Refresh tokens expire after 7 days

## Files Touched
- src/auth.js (read, write)
- src/routes.js (read)
```

**On session start**: if `current_plan.md` exists, inject it as context.
**On plan update**: the model writes to the file via the existing write tool.
**On plan completion**: move to `plan_history/` with timestamp.

### Integration with existing code
SmallCode already has `plan_tracker.js` which tracks plan state in memory. The enhancement is to **persist the tracker's state to disk** as a markdown file, and **reload it on session start**.

**File to modify**: `src/session/plan_tracker.js` (add ~50 lines for persistence)
**New file**: `src/session/plan_persistence.js` (~80 lines for read/write/archive)

### What NOT to copy
- planning-with-files' skill package format (we don't use skill packages)
- GitHub Issues integration from CCPM (not relevant for local-only)

### Can run locally without cloud: ✅

---

## Pattern 4: Project Memory via Spec Injection (Trellis)

### Problem
Different projects have different conventions, but the model treats every project the same. Project-specific knowledge (naming conventions, test frameworks, architecture patterns) must be manually repeated.

### Mechanism
Trellis uses a `.trellis/` directory per project containing:
- `project.yaml` — project metadata, tech stack, conventions
- `specs/` — domain-specific specification files that get injected when relevant
- `memory/` — per-project persistent memory (same concept as Pattern 1, but scoped)

The key idea is **conditional injection**: specs are only injected when the user's message touches a relevant domain. A regex-based router maps message keywords to spec files.

### What to extract (local implementation)

**File**: `src/knowledge/project_specs.js` (~120 lines)

```yaml
# .smallcode/project.yaml
name: LocalAgentHarness
stack: [node, javascript, koboldcpp, gemma]
conventions:
  - "File names must describe contents exactly (no bootstrap.js, utils.js)"
  - "Max 500 lines per file"
  - "Use portable paths: %~d0\\PortableNode\\node.exe"
test_command: "npm test"
specs:
  - match: ["memory", "remember", "context"]
    file: "docs/specs/memory_architecture.md"
  - match: ["security", "sanitize", "permission"]
    file: "docs/specs/security_model.md"
```

On each message:
1. Load `project.yaml`
2. Always inject `conventions` as a system message
3. For each spec, check if any `match` keyword appears in the user message
4. If yes, read and inject the spec file (truncated to fit context budget)

### What NOT to copy
- Trellis' multi-platform support (we only target one platform)
- Cross-agent workflow framework (overkill)

### Can run locally without cloud: ✅

---

## Summary: What to Build

| Priority | Pattern | New File | Lines | Dependencies |
|----------|---------|----------|-------|-------------|
| P0 | Tiered Memory Store | `src/memory/memory_store.js` | ~200 | better-sqlite3 |
| P0 | Compaction Recovery | `src/session/event_journal.js` | ~150 | none |
| P1 | Plan Persistence | `src/session/plan_persistence.js` | ~80 | none (extends plan_tracker) |
| P1 | Project Specs | `src/knowledge/project_specs.js` | ~120 | js-yaml |
| P2 | Memory CLI | `src/memory/memory_cli.js` | ~60 | memory_store.js |
