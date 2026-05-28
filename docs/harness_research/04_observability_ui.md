# 04 — Observability UI Patterns

Patterns extracted from: **VoltAgent** (observability console), **Chorus** (task state UI), **Open Multi-Agent** (live tracing), **OmniCoreAgent** (SSE events), reference harnesses (Cline, aider).

---

## Design Principle: Lightweight Browser UI, Not a Framework

Every project reviewed uses either React, Next.js, or a custom dashboard framework. These are heavyweight for our use case. Our target:

- **Single HTML file** served by a local HTTP server
- **Vanilla JS + CSS** (per GEMINI.md rules)
- **SSE (Server-Sent Events)** for live updates from the agent loop
- **No build step**, no npm dependencies for the UI
- Total size: < 500 lines HTML/CSS/JS combined (split across 2-3 files per the 500-line rule)

---

## Pattern 14: Agent Status Dashboard

### Problem
When the agent is running, the user sees a scrolling terminal log. There's no structured view of: what phase we're in, how many tokens we've used, what files were touched, whether tests are passing, or what the current plan status is.

### Mechanism (synthesized from VoltAgent, Chorus)

VoltAgent ships a web-based **observability console** that shows:
1. **Agent timeline** — each turn as a card with: prompt summary, tool calls, token count, duration
2. **Tool call inspector** — expandable view of each tool call's input/output
3. **Token metrics** — running total of prompt/completion tokens, budget usage bar
4. **Task state** — current phase, plan progress, verification status

Chorus adds:
5. **Session lifecycle** — visual state machine showing session status
6. **Sub-agent status** — (future, for multi-agent)

### What to extract (local implementation)

**Architecture**:
```
Agent Loop (Node.js)
    │
    ├── SSE endpoint: GET /events
    │   Streams: turn_start, tool_call, tool_result, turn_end,
    │            plan_update, phase_change, verification_result,
    │            token_usage, sentinel_warning, error
    │
    ├── REST endpoints:
    │   GET /status        → current agent state
    │   GET /history       → last N turns
    │   GET /plan          → current plan
    │   GET /metrics       → token/time metrics
    │
    └── Static file: GET / → observability.html
```

**File**: `src/tui/observe_server.js` (~180 lines)

```javascript
// Minimal HTTP server using Node's built-in http module (no Express needed)
const http = require('http');
const fs = require('fs');

class ObserveServer {
  constructor(port = 3333) {
    this.port = port;
    this.clients = new Set(); // SSE clients
    this.turnHistory = [];
    this.metrics = { promptTokens: 0, completionTokens: 0, turns: 0, startTime: Date.now() };
  }

  // Called from agent loop after each significant event
  emit(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      client.write(data);
    }
    // Also append to history
    this.turnHistory.push(event);
    if (this.turnHistory.length > 200) this.turnHistory.shift();
  }

  start() {
    const server = http.createServer((req, res) => {
      if (req.url === '/events') return this.handleSSE(req, res);
      if (req.url === '/status') return this.handleStatus(res);
      if (req.url === '/history') return this.handleHistory(res);
      if (req.url === '/plan') return this.handlePlan(res);
      if (req.url === '/metrics') return this.handleMetrics(res);
      if (req.url === '/') return this.serveUI(res);
      res.writeHead(404); res.end('Not found');
    });
    server.listen(this.port);
  }
}
```

**File**: `src/tui/observability.html` (~300 lines — HTML + CSS + JS)

### UI Layout (single page):

```
┌─────────────────────────────────────────────────────┐
│ 🔮 SmallCode Harness — Observability                │
│ Session: abc123 | Phase: implement (3/5) | ⏱ 4m 23s │
├────────────────────┬────────────────────────────────┤
│ PLAN               │ TIMELINE                        │
│ ✓ 1. Read auth     │ ┌──────────────────────────┐   │
│ ✓ 2. Find validate │ │ Turn 7              42 tk │   │
│ → 3. Add refresh   │ │ 🔧 patch src/auth.js     │   │
│ ○ 4. Update routes │ │ ✅ Syntax OK              │   │
│ ○ 5. Run tests     │ │ ⚠️ Lint: 1 warning       │   │
│                    │ └──────────────────────────┘   │
│ TOKEN BUDGET       │ ┌──────────────────────────┐   │
│ ████████░░ 78%     │ │ Turn 6              38 tk │   │
│ 6,240 / 8,000      │ │ 🔧 read_file src/auth.js │   │
│                    │ │ 📄 340 lines read        │   │
│ SENTINELS          │ └──────────────────────────┘   │
│ Loop: ✅ OK        │                                 │
│ Drift: ✅ OK       │ ┌──────────────────────────┐   │
│ Progress: ✅ OK    │ │ Turn 5              15 tk │   │
│ Budget: ⚠️ 78%    │ │ 💬 "I'll add refresh..." │   │
│                    │ └──────────────────────────┘   │
├────────────────────┴────────────────────────────────┤
│ LAST TOOL CALL                                       │
│ patch { file: "src/auth.js",                        │
│   old: "function validateToken(token) {",           │
│   new: "function validateToken(token) {\n  ..." }   │
│ Result: ✅ Applied successfully                      │
└─────────────────────────────────────────────────────┘
```

### CSS Design Notes (per web_application_development guidelines):

```css
/* Dark theme, glassmorphism cards, subtle animations */
:root {
  --bg-primary: #0d1117;
  --bg-card: rgba(22, 27, 34, 0.8);
  --border: rgba(48, 54, 61, 0.6);
  --accent: #58a6ff;
  --success: #3fb950;
  --warning: #d29922;
  --error: #f85149;
  --text: #c9d1d9;
  --text-muted: #8b949e;
}

.card {
  background: var(--bg-card);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.card:hover {
  border-color: var(--accent);
  box-shadow: 0 0 20px rgba(88, 166, 255, 0.1);
}

/* Smooth entry animation for new timeline cards */
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

.timeline-entry { animation: slideIn 0.3s ease-out; }
```

### SSE Event Schema:

```json
// Turn lifecycle events
{"type": "turn_start", "turn": 7, "timestamp": 1716854400}
{"type": "tool_call", "turn": 7, "tool": "patch", "args": {"file": "src/auth.js", "old": "...", "new": "..."}}
{"type": "tool_result", "turn": 7, "tool": "patch", "success": true, "summary": "Applied 1 patch"}
{"type": "turn_end", "turn": 7, "tokens": {"prompt": 2400, "completion": 42}, "duration_ms": 3200}

// Plan events
{"type": "plan_update", "step": 3, "status": "done", "total": 5}

// Phase events
{"type": "phase_change", "from": "plan", "to": "implement"}

// Verification events
{"type": "verification", "check": "syntax", "result": "pass", "file": "src/auth.js"}
{"type": "verification", "check": "test", "result": "fail", "error": "...", "classification": "PROGRESS"}

// Sentinel events
{"type": "sentinel", "name": "budget", "verdict": "warn", "message": "78% of token budget used"}

// Token metrics
{"type": "metrics", "prompt_total": 6240, "completion_total": 380, "budget": 8000}
```

### Integration with Agent Loop:

The agent loop needs exactly **5 emit points**:

1. After prompt construction: `emit({ type: 'turn_start', ... })`
2. After tool call parse: `emit({ type: 'tool_call', ... })`
3. After tool execution: `emit({ type: 'tool_result', ... })`
4. After model response: `emit({ type: 'turn_end', ... })`
5. After sentinel check: `emit({ type: 'sentinel', ... })`

These are non-blocking calls. The UI updates independently via SSE.

---

## Pattern 15: Command Log with Approval State

### Problem
When the agent runs bash commands, the user sees the output but loses track of what was run, whether it was approved, and what the exit code was. There's no audit trail.

### Mechanism (from Cline, OmniCoreAgent)

Every command execution is logged with its approval state:

```json
// .smallcode/sessions/{id}/command_log.jsonl
{"t": 1716854400, "cmd": "npm test", "approved": "auto", "exit": 0, "duration_ms": 3200}
{"t": 1716854500, "cmd": "git diff", "approved": "auto", "exit": 0, "duration_ms": 120}
{"t": 1716854600, "cmd": "rm -rf node_modules", "approved": "user", "exit": 0, "duration_ms": 800}
{"t": 1716854700, "cmd": "curl https://example.com", "approved": "denied", "exit": null, "reason": "network access blocked"}
```

The observability UI shows a **command log panel** with color-coded approval states:
- 🟢 `auto` — safe command, auto-approved
- 🟡 `user` — required user approval
- 🔴 `denied` — blocked by safety rules

### What to extract (local implementation)

**File**: `src/tools/command_logger.js` (~60 lines)

```javascript
// Wraps shell_session.js to log every command with approval state
class CommandLogger {
  constructor(sessionDir) {
    this.logPath = path.join(sessionDir, 'command_log.jsonl');
  }

  log(cmd, approvalType, exitCode, durationMs, reason) {
    const entry = {
      t: Date.now(),
      cmd: cmd.substring(0, 500), // truncate very long commands
      approved: approvalType,
      exit: exitCode,
      duration_ms: durationMs,
      reason: reason || undefined
    };
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    // Also emit to SSE
    this.observer?.emit({ type: 'command', ...entry });
  }
}
```

---

## Summary: What to Build

| Priority | Pattern | New File | Lines | Dependencies |
|----------|---------|----------|-------|-------------|
| P1 | Observe Server | `src/tui/observe_server.js` | ~180 | node http (built-in) |
| P1 | Observability UI | `src/tui/observability.html` | ~300 | none (vanilla) |
| P1 | Observability CSS | `src/tui/observe_styles.css` | ~150 | none |
| P2 | Command Logger | `src/tools/command_logger.js` | ~60 | shell_session.js |
| P2 | SSE Event Emitter | (part of observe_server.js) | — | — |
