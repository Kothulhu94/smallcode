// SmallCode — Tiered Memory Store Governor (Runtime)
//
// Persistent, structured memory store backed by SQLite (better-sqlite3).
// Categorizes memories into decision, convention, gotcha, workflow, and context.
// Indexes text and keywords using FTS5 (with a standard SQL LIKE fallback).
// Ranks results dynamically using keyword overlap relevance, recency decay,
// and frequency use count.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lazy require to avoid crashing on start if SQLite is unavailable
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // If required during test/build without better-sqlite3, will throw on init()
}

const CATEGORIES = {
  DECISION: 'decision',
  CONVENTION: 'convention',
  GOTCHA: 'gotcha',
  WORKFLOW: 'workflow',
  CONTEXT: 'context',
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'to', 'for',
  'in', 'on', 'at', 'by', 'of', 'with', 'about', 'as', 'it', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'us', 'him',
  'them', 'my', 'your', 'his', 'her', 'their', 'our', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'from', 'up', 'down', 'out', 'off',
  'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 's', 't', 'just', 'now'
]);

class MemoryStore {
  /**
   * @param {object} [config={}]
   * @param {string} [config.dbPath] - Path to the SQLite db file (defaults to .smallcode/memory/memory.db)
   * @param {number} [config.ttlDays=30] - Default TTL in days
   * @param {number} [config.maxResults=5] - Default limit on recalled memories
   * @param {Function} [config.now] - Custom function returning Date.now() timestamp (for testing)
   */
  constructor(config = {}) {
    this.config = {
      dbPath: config.dbPath || path.join(process.cwd(), '.smallcode', 'memory', 'memory.db'),
      ttlDays: typeof config.ttlDays === 'number' ? config.ttlDays : 30,
      maxResults: typeof config.maxResults === 'number' ? config.maxResults : 5,
      now: typeof config.now === 'function' ? config.now : () => Date.now(),
    };

    this.db = null;
    this.useFts = true; // Will set to false if FTS5 creation fails
  }

  /**
   * Initialize the database connection, schemas, and directories.
   */
  init() {
    if (!Database) {
      throw new Error('better-sqlite3 is not installed or failed to load.');
    }

    // Ensure parent directory exists for file-based DBs
    if (this.config.dbPath !== ':memory:') {
      const dir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Connect to SQLite
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    // Create main memories table
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        keywords TEXT,
        source TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        use_count INTEGER DEFAULT 0,
        expires_at INTEGER
      )
    `).run();

    // Create FTS5 virtual table
    try {
      this.db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          memory_id,
          text,
          keywords
        )
      `).run();
      this.useFts = true;
    } catch (e) {
      this.useFts = false;
      // FTS5 is not compiled, degrading to LIKE fallback
    }

    // Slice 2D migration: add title column to existing DBs.
    // SQLite does not support ADD COLUMN IF NOT EXISTS, so we inspect
    // PRAGMA table_info and only run ALTER TABLE when the column is missing.
    const existingCols = this.db.pragma('table_info(memories)').map(c => c.name);
    if (!existingCols.includes('title')) {
      this.db.prepare('ALTER TABLE memories ADD COLUMN title TEXT').run();
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
  }

  /**
   * Save a memory entry to the store.
   *
   * @param {object} args
   * @param {string} args.category - decision, convention, gotcha, workflow, or context
   * @param {string} args.text - Full text content of the memory
   * @param {string|Array<string>} [args.keywords] - Keywords for indexing
   * @param {string} [args.source] - Origin context or file source
   * @param {number} [args.ttlDays] - Custom expiry in days overrides default config
   * @returns {string} The created memory ID
   */
  saveMemory({ id, category, title, text, keywords, source, ttlDays }) {
    if (!this.db) throw new Error('Database is not initialized. Call init() first.');

    // Validate category
    const validCategories = new Set(Object.values(CATEGORIES));
    if (!validCategories.has(category)) {
      throw new Error(`Invalid category "${category}". Must be one of: ${[...validCategories].join(', ')}`);
    }

    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new Error('Memory text must be a non-empty string.');
    }

    const finalId = id || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    const now = this.config.now();

    // Format keywords
    let kwStr = '';
    if (Array.isArray(keywords)) {
      kwStr = keywords.join(', ');
    } else if (typeof keywords === 'string') {
      kwStr = keywords;
    }

    // Expiration
    const days = typeof ttlDays === 'number' ? ttlDays : this.config.ttlDays;
    const expiresAt = days > 0 ? now + (days * 24 * 60 * 60 * 1000) : null;

    // Title: store the caller-supplied title when non-blank; otherwise derive
    // a safe fallback from the first line of text so the column is never NULL.
    const storedTitle = (title && typeof title === 'string' && title.trim())
      ? title.trim()
      : text.trim().split('\n')[0].slice(0, 80);

    // Insert main
    this.db.prepare(`
      INSERT INTO memories (id, category, title, text, keywords, source, created_at, last_used, use_count, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(finalId, category, storedTitle, text.trim(), kwStr, source || null, now, now, expiresAt);

    // Insert FTS
    if (this.useFts) {
      try {
        this.db.prepare(`
          INSERT INTO memories_fts (memory_id, text, keywords)
          VALUES (?, ?, ?)
        `).run(finalId, text.trim(), kwStr);
      } catch (e) {
        // Fallback silently if FTS table write fails
      }
    }

    return finalId;
  }

  /**
   * Delete a memory from the store by ID.
   *
   * @param {string} id
   */
  deleteMemory(id) {
    if (!this.db) throw new Error('Database is not initialized.');

    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);

    if (this.useFts) {
      try {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
      } catch (e) {
        // Fallback
      }
    }
  }

  /**
   * Delete a memory by ID — alias used by the dual-delete bridge in bin/memory.js.
   *
   * @param {string} id
   * @returns {boolean} true if a record was deleted
   */
  forget(id) {
    if (!this.db) return false;

    const info = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);

    if (this.useFts && info.changes > 0) {
      try {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
      } catch (e) {
        // Fallback
      }
    }

    return info.changes > 0;
  }

  /**
   * Scan and delete expired memory items.
   *
   * @returns {number} Count of removed memories
   */
  expireOld() {
    if (!this.db) throw new Error('Database is not initialized.');

    const now = this.config.now();

    const info = this.db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);

    if (this.useFts && info.changes > 0) {
      try {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories)').run();
      } catch (e) {
        // Fallback
      }
    }

    return info.changes;
  }

  /**
   * List memories without relevance sorting.
   *
   * @param {object} [options={}]
   * @param {string} [options.category] - Filter by category
   * @param {number} [options.limit] - Max records to return
   * @returns {Array<object>}
   */
  list(options = {}) {
    if (!this.db) throw new Error('Database is not initialized.');

    const now = this.config.now();
    let query = 'SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at >= ?)';
    const params = [now];

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    query += ' ORDER BY created_at DESC';

    if (typeof options.limit === 'number') {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.db.prepare(query).all(...params);
  }

  /**
   * Tokenize query string into keywords, filtering out common stopwords.
   *
   * @param {string} query
   * @returns {Array<string>} List of lowercase keyword tokens
   */
  tokenize(query) {
    if (!query || typeof query !== 'string') return [];
    return query
      .toLowerCase()
      .split(/[^a-zA-Z0-9_-]+/)
      .filter(w => w.trim().length > 0 && !STOPWORDS.has(w));
  }

  /**
   * Recall memories matching the search query, ranked by keyword relevance,
   * recency decay, and frequency use count.
   * Updates access stats for matched records.
   *
   * @param {string} query
   * @param {object} [options={}]
   * @param {string} [options.category] - Filter by category
   * @param {number} [options.limit] - Max results (defaults to maxResults config)
   * @returns {Array<object>} Ranked memories
   */
  recall(query, options = {}) {
    if (!this.db) throw new Error('Database is not initialized.');

    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (!trimmed) {
      return [];
    }

    const keywords = this.tokenize(trimmed);
    if (keywords.length === 0) {
      return [];
    }

    const now = this.config.now();
    const limit = typeof options.limit === 'number' ? options.limit : this.config.maxResults;
    let candidates = [];

    // 1. Fetch candidate records matching any of the tokens
    if (this.useFts) {
      try {
        // FTS MATCH query joining keywords with OR
        const matchQuery = keywords.join(' OR ');

        let querySql = `
          SELECT m.*, fts.rowid as fts_rowid FROM memories m
          JOIN memories_fts fts ON m.id = fts.memory_id
          WHERE memories_fts MATCH ? AND (m.expires_at IS NULL OR m.expires_at >= ?)
        `;
        const params = [matchQuery, now];

        if (options.category) {
          querySql += ' AND m.category = ?';
          params.push(options.category);
        }

        candidates = this.db.prepare(querySql).all(...params);
      } catch (e) {
        // FTS query failed, fallback to LIKE search
        candidates = this._likeRecallSearch(keywords, now, options);
      }
    } else {
      candidates = this._likeRecallSearch(keywords, now, options);
    }

    if (candidates.length === 0) {
      return [];
    }

    // 2. Score and Rank candidates
    for (const cand of candidates) {
      // Relevance: count number of keyword occurrences in text or keywords field
      let matches = 0;
      const textLower = cand.text.toLowerCase();
      const kwLower = (cand.keywords || '').toLowerCase();
      for (const kw of keywords) {
        if (textLower.includes(kw)) matches++;
        if (kwLower.includes(kw)) matches++;
      }
      const relevance = matches;

      // Recency: decay over days
      const ageDays = (now - cand.last_used) / (1000 * 60 * 60 * 24);
      const recency = 1 / (1 + Math.max(0, ageDays));

      // Frequency use factor: cap at 10 uses
      const useCountFactor = Math.min(cand.use_count / 10, 1.0);

      // Total Score
      cand.score = (relevance * 0.6) + (recency * 0.3) + (useCountFactor * 0.1);
    }

    // Sort descending by score
    candidates.sort((a, b) => b.score - a.score);

    // Limit results
    const results = candidates.slice(0, limit);

    // 3. Update last_used and use_count for matched items
    const updateStmt = this.db.prepare('UPDATE memories SET last_used = ?, use_count = use_count + 1 WHERE id = ?');
    for (const item of results) {
      updateStmt.run(now, item.id);

      // Update local values in returned array as well
      item.use_count += 1;
      item.last_used = now;
    }

    return results;
  }

  // ─── Private Helper ────────────────────────────────────────────────────────

  _likeRecallSearch(keywords, now, options) {
    // Generate: (text LIKE ? OR keywords LIKE ?) OR ...
    const likeClauses = keywords.map(() => '(text LIKE ? OR keywords LIKE ?)').join(' OR ');

    let querySql = `
      SELECT * FROM memories
      WHERE (${likeClauses}) AND (expires_at IS NULL OR expires_at >= ?)
    `;
    const params = [];
    for (const kw of keywords) {
      params.push(`%${kw}%`, `%${kw}%`);
    }
    params.push(now);

    if (options.category) {
      querySql += ' AND category = ?';
      params.push(options.category);
    }

    return this.db.prepare(querySql).all(...params);
  }
}

module.exports = {
  MemoryStore,
  CATEGORIES,
  DECISION: CATEGORIES.DECISION,
  CONVENTION: CATEGORIES.CONVENTION,
  GOTCHA: CATEGORIES.GOTCHA,
  WORKFLOW: CATEGORIES.WORKFLOW,
  CONTEXT: CATEGORIES.CONTEXT,
};
