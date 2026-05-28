// SmallCode — Event Journal
//
// Append-only JSONL event log for session recovery after context compaction.
// Each session gets its own journal file at:
//
//   .smallcode/sessions/{sessionId}/events.jsonl
//
// Every significant agent action (file read, file write, decision, plan step,
// tool result, error) is appended as a one-line JSON object. When the context
// window is compacted, the journal is read to build a recovery prompt that
// tells the model what happened before the compaction boundary.
//
// Design constraints:
//   - Append-only. Never rewrite the journal mid-session.
//   - Tolerate missing, empty, or partially corrupted files.
//   - Skip malformed lines without crashing.
//   - No npm dependencies — Node built-ins only.
//   - Never throw into the agent loop. All public methods are fail-safe.
//
// This module is standalone. Nothing in the agent loop calls it until we
// explicitly wire it in during a future integration task.

'use strict';

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = '.smallcode/sessions';
const JOURNAL_FILENAME = 'events.jsonl';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Maximum single event payload size (bytes). Prevents runaway tool outputs
// from bloating the journal. Content is truncated, not rejected.
const MAX_PAYLOAD_SIZE = 8192;

// Maximum events returned by readRecent() by default.
const DEFAULT_RECENT_LIMIT = 50;

// Known event types. Not enforced (future types can be added freely), but
// used by buildRecoverySummary() to categorize events for the recovery prompt.
const EVENT_TYPES = {
  FILE_READ:     'file_read',
  FILE_WRITE:    'file_write',
  DECISION:      'decision',
  PLAN_STEP:     'plan_step',
  TOOL_CALL:     'tool_call',
  TOOL_RESULT:   'tool_result',
  VERIFICATION:  'verification',
  ERROR:         'error',
  PHASE_CHANGE:  'phase_change',
  COMPACTION:    'compaction',
  SESSION_START: 'session_start',
  SESSION_END:   'session_end',
};

// ─── EventJournal class ─────────────────────────────────────────────────────

class EventJournal {
  /**
   * @param {string} sessionId — unique session identifier
   * @param {string} [rootDir] — workspace root (defaults to cwd)
   */
  constructor(sessionId, rootDir) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('EventJournal requires a non-empty sessionId');
    }
    this.sessionId = sessionId;
    this.rootDir = rootDir || process.cwd();
    this.journalDir = path.join(this.rootDir, SESSIONS_DIR, sessionId);
    this.journalPath = path.join(this.journalDir, JOURNAL_FILENAME);
    this._ensureDir();
  }

  // ─── Writing ────────────────────────────────────────────────────────────

  /**
   * Append a single event to the journal.
   *
   * @param {string} type — one of EVENT_TYPES or any custom string
   * @param {object} [payload] — arbitrary data (truncated if too large)
   * @param {string[]} [tags] — optional tags for filtering
   * @returns {{ ok: boolean, error?: string }}
   */
  append(type, payload, tags) {
    try {
      const event = {
        t: Date.now(),
        sid: this.sessionId,
        type: String(type || 'unknown'),
      };

      if (payload !== undefined && payload !== null) {
        event.data = this._safePayload(payload);
      }

      if (Array.isArray(tags) && tags.length > 0) {
        event.tags = tags.map(t => String(t).slice(0, 50)).slice(0, 10);
      }

      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.journalPath, line, { mode: FILE_MODE });
      return { ok: true };
    } catch (e) {
      // Never crash the caller
      return { ok: false, error: e.message };
    }
  }

  // ─── Reading ────────────────────────────────────────────────────────────

  /**
   * Read all events from the journal.
   * Malformed lines are skipped and counted.
   *
   * @returns {{ events: object[], skipped: number }}
   */
  readAll() {
    return this._readLines();
  }

  /**
   * Read the most recent N events.
   *
   * @param {number} [limit] — max events to return (default 50)
   * @returns {{ events: object[], skipped: number }}
   */
  readRecent(limit) {
    const n = Math.max(1, Math.min(limit || DEFAULT_RECENT_LIMIT, 10000));
    const result = this._readLines();
    if (result.events.length > n) {
      result.events = result.events.slice(-n);
    }
    return result;
  }

  /**
   * Read events filtered by type.
   *
   * @param {string|string[]} types — event type(s) to include
   * @returns {{ events: object[], skipped: number }}
   */
  readByType(types) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const result = this._readLines();
    result.events = result.events.filter(e => typeSet.has(e.type));
    return result;
  }

  // ─── Recovery ───────────────────────────────────────────────────────────

  /**
   * Build a human-readable recovery summary for injection after compaction.
   *
   * Returns a structured object with:
   *   - filesRead:    files the model read (path + summary if available)
   *   - filesWritten: files the model edited (path + patch summary)
   *   - decisions:    decisions made during the session
   *   - planState:    most recent plan step status
   *   - lastResults:  last N tool results
   *   - text:         pre-formatted text block ready for prompt injection
   *
   * @param {object} [options]
   * @param {number} [options.maxResults=5] — how many recent tool results
   * @param {number} [options.maxEvents=200] — look-back window
   * @returns {object}
   */
  buildRecoverySummary(options = {}) {
    const maxResults = options.maxResults || 5;
    const maxEvents = options.maxEvents || 200;

    const { events } = this.readRecent(maxEvents);

    const filesRead = new Map();    // path → summary
    const filesWritten = new Map(); // path → last patch description
    const decisions = [];
    let planState = null;
    const lastResults = [];

    for (const ev of events) {
      switch (ev.type) {
        case EVENT_TYPES.FILE_READ:
          if (ev.data && ev.data.path) {
            filesRead.set(ev.data.path, ev.data.summary || null);
          }
          break;

        case EVENT_TYPES.FILE_WRITE:
          if (ev.data && ev.data.path) {
            filesWritten.set(ev.data.path, ev.data.summary || ev.data.patch || null);
          }
          break;

        case EVENT_TYPES.DECISION:
          if (ev.data && ev.data.content) {
            decisions.push(ev.data.content);
          }
          break;

        case EVENT_TYPES.PLAN_STEP:
          planState = ev.data || planState;
          break;

        case EVENT_TYPES.TOOL_RESULT:
          lastResults.push({
            tool: ev.data && ev.data.tool,
            summary: ev.data && ev.data.summary,
            success: ev.data && ev.data.success,
          });
          break;

        // Other types are not included in recovery summary
        default:
          break;
      }
    }

    // Trim results to most recent N
    const recentResults = lastResults.slice(-maxResults);

    // Build human-readable text block
    const lines = ['SESSION RECOVERY (context was compacted):'];

    if (filesRead.size > 0) {
      const readList = [...filesRead.entries()]
        .map(([p, s]) => s ? `  ${p} (${s})` : `  ${p}`)
        .join('\n');
      lines.push(`- Files read:\n${readList}`);
    }

    if (filesWritten.size > 0) {
      const writeList = [...filesWritten.entries()]
        .map(([p, s]) => s ? `  ${p} — ${s}` : `  ${p}`)
        .join('\n');
      lines.push(`- Files written:\n${writeList}`);
    }

    if (decisions.length > 0) {
      lines.push(`- Decisions made:\n${decisions.map(d => `  • ${d}`).join('\n')}`);
    }

    if (planState) {
      const step = planState.step || '?';
      const total = planState.total || '?';
      const status = planState.status || 'unknown';
      lines.push(`- Plan progress: step ${step}/${total} (${status})`);
    }

    if (recentResults.length > 0) {
      const resultList = recentResults
        .map(r => {
          const icon = r.success ? '✅' : '❌';
          return `  ${icon} ${r.tool || 'unknown'}: ${r.summary || 'no summary'}`;
        })
        .join('\n');
      lines.push(`- Recent tool results:\n${resultList}`);
    }

    const text = lines.join('\n');

    return {
      filesRead: Object.fromEntries(filesRead),
      filesWritten: Object.fromEntries(filesWritten),
      decisions,
      planState,
      lastResults: recentResults,
      text,
      eventCount: events.length,
    };
  }

  // ─── Utilities ──────────────────────────────────────────────────────────

  /**
   * Return the number of events in the journal (fast line count).
   * @returns {number}
   */
  count() {
    try {
      if (!fs.existsSync(this.journalPath)) return 0;
      const content = fs.readFileSync(this.journalPath, 'utf-8');
      if (!content) return 0;
      // Count non-empty lines
      return content.split('\n').filter(line => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Return the path to the journal file (for debugging/testing).
   * @returns {string}
   */
  filepath() {
    return this.journalPath;
  }

  /**
   * Check if the journal file exists and is non-empty.
   * @returns {boolean}
   */
  exists() {
    try {
      if (!fs.existsSync(this.journalPath)) return false;
      const stat = fs.statSync(this.journalPath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Ensure the session directory exists. */
  _ensureDir() {
    try {
      if (!fs.existsSync(this.journalDir)) {
        fs.mkdirSync(this.journalDir, { recursive: true, mode: DIR_MODE });
      }
    } catch {
      // Best-effort — if we can't create the dir, append() will fail safely
    }
  }

  /**
   * Read and parse all lines from the journal file.
   * Skips blank lines and malformed JSON without throwing.
   */
  _readLines() {
    const events = [];
    let skipped = 0;

    try {
      if (!fs.existsSync(this.journalPath)) {
        return { events, skipped: 0 };
      }

      const content = fs.readFileSync(this.journalPath, 'utf-8');
      if (!content) return { events, skipped: 0 };

      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        try {
          const parsed = JSON.parse(trimmed);
          events.push(parsed);
        } catch {
          skipped++;
        }
      }
    } catch {
      // File read error — return whatever we have
    }

    return { events, skipped };
  }

  /**
   * Sanitize a payload object to stay within size limits.
   * Serializes to JSON, truncates if too large, and re-parses.
   * Falls back to a truncated string representation on failure.
   */
  _safePayload(payload) {
    try {
      const json = JSON.stringify(payload);
      if (json.length <= MAX_PAYLOAD_SIZE) {
        return payload; // fits as-is
      }
      // Truncate: try to preserve structure by keeping a subset
      if (typeof payload === 'string') {
        return payload.slice(0, MAX_PAYLOAD_SIZE) + '…[truncated]';
      }
      if (typeof payload === 'object' && payload !== null) {
        // Shallow copy with truncated string values
        const trimmed = {};
        let size = 0;
        for (const [key, val] of Object.entries(payload)) {
          const valStr = typeof val === 'string'
            ? val.slice(0, 500)
            : JSON.stringify(val).slice(0, 500);
          trimmed[key] = typeof val === 'string' ? valStr : val;
          size += key.length + valStr.length;
          if (size > MAX_PAYLOAD_SIZE) {
            trimmed._truncated = true;
            break;
          }
        }
        return trimmed;
      }
      return payload;
    } catch {
      return { _error: 'payload serialization failed' };
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────
// Convenience function to open or create a journal for a session.
// Does not use a singleton — each session gets its own journal instance.

function openJournal(sessionId, rootDir) {
  return new EventJournal(sessionId, rootDir);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  EventJournal,
  openJournal,
  EVENT_TYPES,
};
