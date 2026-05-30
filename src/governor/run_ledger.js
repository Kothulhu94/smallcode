// SmallCode — Run Ledger / Trace Store (Milestone 6A)
//
// Durable SQLite-backed ledger that records agent/task execution events
// for later debugging, analytics, and dashboard visualization.
//
// Tables:
//   runs                 — one row per agent loop invocation
//   run_steps            — sequential steps within a run (tool, model, etc.)
//   tool_calls           — detailed tool call records
//   authorization_events — tool authorization checks (pass/deny/warn)
//   memory_context_events — memory context loading details
//
// Design:
//   - Lazy init: db only created when first event is recorded
//   - WAL mode for concurrent reads during dashboard queries
//   - All writes are contained — ledger errors never break the agent
//   - Follows memory_store.js patterns for SQLite lifecycle

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // Will degrade gracefully when SQLite is unavailable
}

class RunLedger {
  /**
   * @param {object} [config={}]
   * @param {string} [config.dbPath] - Path to ledger DB (defaults to .smallcode/ledger/runs.db)
   * @param {Function} [config.now] - Custom timestamp function for testing
   */
  constructor(config = {}) {
    this.config = {
      dbPath: config.dbPath || path.join(process.cwd(), '.smallcode', 'ledger', 'runs.db'),
      now: typeof config.now === 'function' ? config.now : () => Date.now(),
    };
    this.db = null;
    this._initialized = false;
    this._closed = false;
  }

  /**
   * Lazily initialize the database and create tables.
   * Called automatically before any write — callers don't need to call this.
   */
  init() {
    if (this._initialized) return;
    if (!Database) return; // No SQLite available — degrade silently

    // Ensure parent directory exists
    if (this.config.dbPath !== ':memory:') {
      const dir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        prompt TEXT,
        model TEXT,
        task_type TEXT,
        agent_id TEXT,
        model_preset TEXT,
        status TEXT DEFAULT 'running',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        tool_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0
      )
    `).run();

    try {
      const columns = this.db.prepare('PRAGMA table_info(runs)').all();
      const hasModelPreset = columns.some(col => col.name === 'model_preset');
      if (!hasModelPreset) {
        this.db.prepare('ALTER TABLE runs ADD COLUMN model_preset TEXT').run();
      }
    } catch (e) {
      // Degrade silently
    }

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        name TEXT,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        success INTEGER,
        summary TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step_index INTEGER,
        tool_name TEXT NOT NULL,
        args_json TEXT,
        result_summary TEXT,
        success INTEGER NOT NULL,
        duration_ms INTEGER,
        called_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS authorization_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        tool_name TEXT NOT NULL,
        task_type TEXT,
        agent_id TEXT,
        mode TEXT,
        authorized INTEGER NOT NULL,
        reason TEXT,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      )
    `).run();

    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS memory_context_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        task_type TEXT,
        agent_id TEXT,
        budget_requested INTEGER,
        budget_resolved INTEGER,
        categories_allowed TEXT,
        items_loaded INTEGER,
        tokens_used INTEGER,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      )
    `).run();

    // Indexes for dashboard queries
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_auth_events_run ON authorization_events(run_id)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_memory_events_run ON memory_context_events(run_id)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id)').run();

    this._initialized = true;
  }

  /**
   * Ensure db is ready. Returns false if SQLite is unavailable.
   */
  _ensureDb() {
    if (this._closed) return false;
    if (!this._initialized) {
      try {
        this.init();
      } catch (e) {
        return false;
      }
    }
    return !!this.db;
  }

  // ─── Run Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a new run. Returns the run ID.
   * @param {object} params
   * @param {string} params.prompt - User prompt that triggered this run
   * @param {string} [params.model] - Model name
   * @param {string} [params.taskType] - Classified task type
   * @param {string} [params.agentId] - Resolved agent ID
   * @param {string} [params.modelPreset] - Resolved agent model preset
   * @returns {string|null} The run ID, or null if ledger is unavailable
   */
  startRun(firstArg, ...args) {
    if (!this._ensureDb()) return null;
    let id, prompt, model, taskType, agentId, modelPreset;
    if (firstArg && typeof firstArg === 'object') {
      prompt = firstArg.prompt;
      model = firstArg.model;
      taskType = firstArg.taskType;
      agentId = firstArg.agentId;
      modelPreset = firstArg.modelPreset;
      id = crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : crypto.randomBytes(6).toString('hex');
    } else {
      id = firstArg;
      taskType = args[0];
      agentId = args[1];
      modelPreset = args[2];
      prompt = args[3];
    }
    const now = this.config.now();
    try {
      this.db.prepare(`
        INSERT INTO runs (id, prompt, model, task_type, agent_id, model_preset, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(id, (prompt || '').slice(0, 500), model || null, taskType || null, agentId || null, modelPreset || null, now);
      return id;
    } catch (e) {
      return null;
    }
  }

  /**
   * End a run, recording final status and aggregates.
   * @param {string} runId
   * @param {object} [params={}]
   * @param {string} [params.status] - 'completed' | 'error' | 'cancelled'
   * @param {number} [params.promptTokens]
   * @param {number} [params.completionTokens]
   */
  endRun(runId, { status, promptTokens, completionTokens } = {}) {
    if (!this._ensureDb() || !runId) return;
    const now = this.config.now();
    try {
      // Count tools and errors from tool_calls table
      const counts = this.db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
        FROM tool_calls WHERE run_id = ?
      `).get(runId);
      const run = this.db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId);
      const durationMs = run ? now - run.started_at : 0;

      this.db.prepare(`
        UPDATE runs SET status = ?, ended_at = ?, duration_ms = ?,
          tool_count = ?, error_count = ?,
          prompt_tokens = COALESCE(prompt_tokens, 0) + ?,
          completion_tokens = COALESCE(completion_tokens, 0) + ?
        WHERE id = ?
      `).run(
        status || 'completed', now, durationMs,
        counts?.total || 0, counts?.errors || 0,
        promptTokens || 0, completionTokens || 0,
        runId
      );
    } catch (e) {
      // Ledger errors are contained
    }
  }

  // ─── Step Recording ─────────────────────────────────────────────────────────

  /**
   * Record a sequential step within a run.
   * @param {object} params
   * @returns {number|null} step ID
   */
  recordStep({ runId, stepIndex, stepType, name, durationMs, success, summary } = {}) {
    if (!this._ensureDb() || !runId) return null;
    const now = this.config.now();
    try {
      const info = this.db.prepare(`
        INSERT INTO run_steps (run_id, step_index, step_type, name, started_at, duration_ms, success, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, stepIndex || 0, stepType || 'unknown', name || null, now, durationMs || null,
        success !== undefined ? (success ? 1 : 0) : null,
        summary ? String(summary).slice(0, 500) : null);
      return info.lastInsertRowid;
    } catch (e) {
      return null;
    }
  }

  // ─── Tool Call Recording ────────────────────────────────────────────────────

  /**
   * Record a tool call execution.
   * @param {object} params
   * @returns {number|null} tool call ID
   */
  recordToolCall({ runId, stepIndex, toolName, args, resultSummary, success, durationMs } = {}) {
    if (!this._ensureDb()) return null;
    const now = this.config.now();
    try {
      // Serialize args but limit size to prevent bloat
      let argsJson = null;
      if (args !== undefined && args !== null) {
        try {
          argsJson = JSON.stringify(args).slice(0, 2000);
        } catch (e) {
          argsJson = '{}';
        }
      }
      const info = this.db.prepare(`
        INSERT INTO tool_calls (run_id, step_index, tool_name, args_json, result_summary, success, duration_ms, called_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId || null, stepIndex || null, toolName || 'unknown',
        argsJson, resultSummary ? String(resultSummary).slice(0, 1000) : null,
        success ? 1 : 0, durationMs || null, now
      );
      return Number(info.lastInsertRowid);
    } catch (e) {
      return null;
    }
  }

  // ─── Authorization Recording ────────────────────────────────────────────────

  /**
   * Record a tool authorization check.
   * @param {object} params
   */
  recordAuthorization({ runId, toolName, taskType, agentId, mode, authorized, reason } = {}) {
    if (!this._ensureDb()) return null;
    const now = this.config.now();
    try {
      const info = this.db.prepare(`
        INSERT INTO authorization_events (run_id, tool_name, task_type, agent_id, mode, authorized, reason, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId || null, toolName || 'unknown', taskType || null, agentId || null,
        mode || 'warn', authorized ? 1 : 0,
        reason ? String(reason).slice(0, 500) : null, now
      );
      return Number(info.lastInsertRowid);
    } catch (e) {
      return null;
    }
  }

  // ─── Memory Context Recording ───────────────────────────────────────────────

  /**
   * Record a memory context loading event.
   * @param {object} params
   */
  recordMemoryContext({ runId, taskType, agentId, budgetRequested, budgetResolved, categoriesAllowed, itemsLoaded, tokensUsed } = {}) {
    if (!this._ensureDb()) return null;
    const now = this.config.now();
    try {
      const cats = Array.isArray(categoriesAllowed) ? categoriesAllowed.join(',') : (categoriesAllowed || null);
      const info = this.db.prepare(`
        INSERT INTO memory_context_events (run_id, task_type, agent_id, budget_requested, budget_resolved, categories_allowed, items_loaded, tokens_used, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId || null, taskType || null, agentId || null,
        budgetRequested || null, budgetResolved || null,
        cats, itemsLoaded || null, tokensUsed || null, now
      );
      return Number(info.lastInsertRowid);
    } catch (e) {
      return null;
    }
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this._initialized = false;
    this._closed = true;
  }
}

// Bind query methods to RunLedger prototype dynamically to keep file size under 500 lines
const queries = require('./ledger_queries');
for (const [name, fn] of Object.entries(queries)) {
  if (typeof fn !== 'function') {
    throw new TypeError(`RunLedger prototype method "${name}" in ledger_queries is not a function`);
  }
}
Object.assign(RunLedger.prototype, queries);

// ─── Singleton access ─────────────────────────────────────────────────────────

let _defaultLedger = null;

/**
 * Get or create the default ledger singleton.
 * @param {object} [config] - Optional config overrides (only used on first call)
 * @returns {RunLedger}
 */
function getLedger(config) {
  if (!_defaultLedger) {
    _defaultLedger = new RunLedger(config);
  }
  return _defaultLedger;
}

/**
 * Reset the singleton (for testing).
 */
function resetLedger() {
  if (_defaultLedger) {
    _defaultLedger.close();
    _defaultLedger = null;
  }
}

module.exports = {
  RunLedger,
  getLedger,
  resetLedger,
};
