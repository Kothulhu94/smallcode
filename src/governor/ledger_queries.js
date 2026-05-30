// SmallCode — RunLedger Query & Reporting Methods
// Contains functions extracted from run_ledger.js to reduce its file length.

'use strict';

/**
 * Get a run by ID with its step/tool counts.
 * @param {string} runId
 * @returns {object|null}
 */
function getRun(runId) {
  if (!this._ensureDb() || !runId) return null;
  try {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) return null;

    const steps = this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
    const toolCalls = this.db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY called_at').all(runId);
    const authEvents = this.db.prepare('SELECT * FROM authorization_events WHERE run_id = ? ORDER BY recorded_at').all(runId);
    const memEvents = this.db.prepare('SELECT * FROM memory_context_events WHERE run_id = ? ORDER BY recorded_at').all(runId);

    return {
      ...run,
      steps,
      toolCalls,
      authEvents,
      memEvents,
    };
  } catch (e) {
    return null;
  }
}

/**
 * List recent runs (summary only — no nested steps).
 * @param {object} [options={}]
 * @param {number} [options.limit=20]
 * @param {string} [options.status] - Filter by status
 * @returns {Array}
 */
function listRuns({ limit, status } = {}) {
  if (!this._ensureDb()) return [];
  const maxRows = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : 20;
  try {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?'
      ).all(status, maxRows);
    }
    return this.db.prepare(
      'SELECT * FROM runs ORDER BY started_at DESC LIMIT ?'
    ).all(maxRows);
  } catch (e) {
    return [];
  }
}

/**
 * Get tool call statistics aggregated across recent runs.
 * @param {number} [limit=50] - Number of recent runs to aggregate over
 * @returns {object}
 */
function getToolStats(limit = 50) {
  if (!this._ensureDb()) return { tools: [], totalCalls: 0 };
  try {
    const tools = this.db.prepare(`
      SELECT tool_name, COUNT(*) as call_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        AVG(duration_ms) as avg_duration_ms
      FROM tool_calls
      WHERE run_id IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ?)
      GROUP BY tool_name
      ORDER BY call_count DESC
    `).all(limit);

    const totalCalls = tools.reduce((sum, t) => sum + t.call_count, 0);
    return { tools, totalCalls };
  } catch (e) {
    return { tools: [], totalCalls: 0 };
  }
}

/**
 * Get authorization denial/warning statistics.
 * @param {number} [limit=50]
 * @returns {Array}
 */
function getAuthStats(limit = 50) {
  if (!this._ensureDb()) return [];
  try {
    return this.db.prepare(`
      SELECT tool_name, agent_id, mode,
        SUM(CASE WHEN authorized = 1 THEN 1 ELSE 0 END) as allowed_count,
        SUM(CASE WHEN authorized = 0 THEN 1 ELSE 0 END) as denied_count
      FROM authorization_events
      WHERE run_id IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT ?)
      GROUP BY tool_name, agent_id, mode
      ORDER BY denied_count DESC
    `).all(limit);
  } catch (e) {
    return [];
  }
}

/**
 * Get all steps for a run.
 */
function getRunSteps(runId) {
  if (!this._ensureDb() || !runId) return [];
  try {
    return this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
  } catch (e) {
    return [];
  }
}

/**
 * Get all tool calls for a run.
 */
function getToolCalls(runId) {
  if (!this._ensureDb() || !runId) return [];
  try {
    return this.db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY called_at').all(runId);
  } catch (e) {
    return [];
  }
}

/**
 * Get all authorization events for a run.
 */
function getAuthorizationEvents(runId) {
  if (!this._ensureDb() || !runId) return [];
  try {
    return this.db.prepare('SELECT * FROM authorization_events WHERE run_id = ? ORDER BY recorded_at').all(runId);
  } catch (e) {
    return [];
  }
}

/**
 * Get all memory context events for a run.
 */
function getMemoryContextEvents(runId) {
  if (!this._ensureDb() || !runId) return [];
  try {
    return this.db.prepare('SELECT * FROM memory_context_events WHERE run_id = ? ORDER BY recorded_at').all(runId);
  } catch (e) {
    return [];
  }
}

/**
 * Get full details of a run (alias of getRun).
 */
function getRunDetail(runId) {
  return this.getRun(runId);
}

/**
 * Get aggregated statistics of all runs.
 */
function getStats() {
  if (!this._ensureDb()) return { totalRuns: 0, successCount: 0, errorCount: 0, avgDurationMs: 0, totalPromptTokens: 0, totalCompletionTokens: 0 };
  try {
    const counts = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        AVG(duration_ms) as avg_duration,
        SUM(prompt_tokens) as total_prompt,
        SUM(completion_tokens) as total_completion
      FROM runs
    `).get();
    
    return {
      totalRuns: counts?.total || 0,
      successCount: counts?.success || 0,
      errorCount: counts?.error || 0,
      avgDurationMs: Math.round(counts?.avg_duration || 0),
      totalPromptTokens: counts?.total_prompt || 0,
      totalCompletionTokens: counts?.total_completion || 0
    };
  } catch (e) {
    return { totalRuns: 0, successCount: 0, errorCount: 0, avgDurationMs: 0, totalPromptTokens: 0, totalCompletionTokens: 0 };
  }
}

module.exports = {
  getRun,
  listRuns,
  getToolStats,
  getAuthStats,
  getRunSteps,
  getToolCalls,
  getAuthorizationEvents,
  getMemoryContextEvents,
  getRunDetail,
  getStats,
};
