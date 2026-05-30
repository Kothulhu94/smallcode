// SmallCode — Structured Memory System
// Inspired by @aictx/memory: a local wiki for AI agents
// Stores typed knowledge objects that persist across sessions
//
// Memory types:
//   decision    — choices and constraints future sessions should respect
//   workflow    — repeatable procedures (build, test, deploy)
//   gotcha      — known traps and workarounds
//   convention  — code style, naming, architecture patterns
//   context     — project intent, domain knowledge, feature maps
//   source      — where facts came from (file, commit, discussion)

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = '.smallcode/memory';
const INDEX_FILE = '.smallcode/memory/index.json';

const {
  MemoryObject,
  _rowToMemoryObject,
  renderMemoryForContext,
  getMemoryTools,
  executeMemoryTool,
  formatForContext,
  formatList,
  stats
} = require('./memory_helpers');

// MemoryObject and formatting helpers are imported from ./memory_helpers

// ─── Memory Store ────────────────────────────────────────────────────────────

class MemoryStore {
  constructor(rootDir) {
    this.rootDir = rootDir || process.cwd();
    this.memDir = path.join(this.rootDir, MEMORY_DIR);
    this.objects = new Map();
    this.sqliteStore = null;

    try {
      const { MemoryStore: SqliteMemoryStore } = require('../src/memory/memory_store');
      this.sqliteStore = new SqliteMemoryStore({
        dbPath: path.join(this.memDir, 'memory.db')
      });
    } catch (e) {
      // Gracefully ignore better-sqlite3 load errors
    }

    this.load();
  }

  // Initialize memory directory
  init() {
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
    if (this.sqliteStore) {
      try {
        this.sqliteStore.init();
      } catch (e) {
        // Fall back gracefully
      }
    }
    this.save();
    return true;
  }

  // Load all memory objects from disk
  load() {
    if (!fs.existsSync(this.memDir)) return;
    const indexPath = path.join(this.memDir, 'index.json');
    if (!fs.existsSync(indexPath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const obj of (data.objects || [])) {
        this.objects.set(obj.id, new MemoryObject(obj));
      }
    } catch {}
  }

  // Save all memory objects to disk
  save() {
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
    const data = {
      version: 1,
      objects: Array.from(this.objects.values()).map(o => o.toJSON()),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.memDir, 'index.json'), JSON.stringify(data, null, 2));

    // Also write individual markdown files for human review
    for (const obj of this.objects.values()) {
      const filename = `${obj.type}-${obj.id}.md`;
      const md = `# ${obj.title}\n\nType: ${obj.type}\nTags: ${obj.tags.join(', ')}\nCreated: ${obj.createdAt}\n\n${obj.content}\n`;
      fs.writeFileSync(path.join(this.memDir, filename), md);
    }
  }

  // Save/remember a new memory object
  // Supports both object-arg signature (remember(obj)) and positional args (remember(type, title, content, opts)).
  // opts.id allows callers to preserve an existing ID (Slice 2B).
  remember(typeOrObj, title, content, opts = {}) {
    let type, tags, source, relations, id, ttlDays, isAutomatic, taskType;
    if (typeOrObj && typeof typeOrObj === 'object') {
      const o = typeOrObj;
      type = o.type;
      title = o.title;
      content = o.content;
      tags = o.tags;
      source = o.source;
      relations = o.relations;
      id = o.id;
      ttlDays = o.ttlDays;
      isAutomatic = o.isAutomatic;
      taskType = o.taskType;
    } else {
      type = typeOrObj;
      tags = opts.tags;
      source = opts.source;
      relations = opts.relations;
      id = opts.id;
      ttlDays = opts.ttlDays;
      isAutomatic = opts.isAutomatic;
      taskType = opts.taskType;
    }

    // Apply Memory Write Policy
    const { validateAndProcessWrite } = require('../src/memory/write_policy');
    const policyResult = validateAndProcessWrite(this, type, title, content, {
      tags,
      ttlDays,
      isAutomatic,
      taskType,
    });

    if (policyResult.rejected) {
      return {
        rejected: true,
        reason: policyResult.reason,
      };
    }

    if (policyResult.duplicate) {
      const existingObj = this.get(policyResult.existing_id);
      if (existingObj) {
        existingObj.duplicate = true;
        existingObj.existing_id = policyResult.existing_id;
        return existingObj;
      }
      return {
        duplicate: true,
        existing_id: policyResult.existing_id,
        id: policyResult.existing_id,
        type: type || 'context',
        title: title || '',
        content: content || '',
      };
    }

    if (policyResult.supersededId) {
      this.forget(policyResult.supersededId);
    }

    const resolvedTtlDays = policyResult.ttlDays;

    const obj = new MemoryObject({ id, type, title, content, tags, source, relations });
    this.objects.set(obj.id, obj);
    this.save();

    // Dual-write to SQLite
    if (this.sqliteStore) {
      try {
        let category = type || 'context';
        const validCategories = new Set(['decision', 'convention', 'gotcha', 'workflow', 'context']);
        if (!validCategories.has(category)) {
          category = 'context';
        }

        let keywords = tags || [];
        let sourceStr = '';
        if (source && typeof source === 'object') {
          sourceStr = JSON.stringify(source);
        } else if (source) {
          sourceStr = String(source);
        }

        this.sqliteStore.saveMemory({
          id: obj.id,
          category,
          title: title || '',
          text: content || '',
          keywords,
          source: sourceStr,
          ttlDays: typeof resolvedTtlDays === 'number' ? resolvedTtlDays : undefined
        });
      } catch (e) {
        // Dual-write failure is contained
      }
    }

    return obj;
  }

  // Load relevant memory for a task.
  //
  // Slice 2C (updated): recall candidates from SQLite (FTS5 + ranked),
  // then trim to maxTokens using real per-item token estimation.
  // Token estimate: ceil(chars/4) on the rendered form — same as formatForContext().
  // Candidate pool: always fetch CANDIDATE_POOL rows so the token trim
  // decides the cut rather than a rough ceil(maxTokens/50) guess.
  // Falls back to the legacy JSON keyword loop when SQLite is unavailable,
  // empty, or throws.
  //
  // Return shape is always a plain MemoryObject[] — callers are unchanged.
  loadForTask(taskDescription, maxTokens, options = {}) {
    const taskType = options.taskType;
    const activeAgent = options.activeAgent;
    let budget = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 800;
    let allowedCategories = null;

    if (activeAgent || taskType) {
      try {
        const { applyPolicy } = require('../src/memory/context_policy');
        const policy = applyPolicy(taskType, budget);
        let policyBudget = policy.maxTokens;
        let policyCategories = policy.categories;

        const { getActiveAgentContext } = require('../src/governor/agent_registry');
        const agentCtx = activeAgent || (taskType ? getActiveAgentContext(taskType) : null);

        if (agentCtx) {
          budget = Math.min(policyBudget, agentCtx.memoryBudget);
          const agentReadSet = new Set(agentCtx.memoryPermissions.read);
          allowedCategories = policyCategories.filter(cat => agentReadSet.has(cat));
        } else {
          budget = policyBudget;
          allowedCategories = policyCategories;
        }
      } catch (e) {
        // Fall back gracefully to raw budget
      }
    }

    // Token estimator: mirrors the render format used by callers and formatForContext.
    function estimateItemTokens(item) {
      const rendered = renderMemoryForContext(item);
      return Math.ceil(rendered.length / 4);
    }

    let finalResult = null;

    // ── SQLite path (preferred) ───────────────────────────────────────────────
    if (this.sqliteStore && this.sqliteStore.db) {
      try {
        // Fetch a generous candidate pool — let the token trim decide the cut.
        const CANDIDATE_POOL = 20;
        const rows = this.sqliteStore.recall(taskDescription, { limit: CANDIDATE_POOL });
        if (rows && rows.length > 0) {
          // Map SQLite rows → MemoryObject-compatible plain objects.
          let candidates = rows.map(_rowToMemoryObject);

          // Apply category filtering
          if (allowedCategories) {
            candidates = candidates.filter(item => allowedCategories.includes(item.type));
          }

          // Walk ranked candidates, accumulate token cost, stop when over budget.
          const result = [];
          let spent = 0;
          for (const item of candidates) {
            const cost = estimateItemTokens(item);
            if (spent + cost > budget) break;
            result.push(item);
            spent += cost;
          }
          finalResult = result;
        }
        // SQLite returned nothing — fall through to legacy path
      } catch (e) {
        // SQLite recall failure is non-fatal; fall through to legacy
      }
    }

    // ── Legacy JSON path (fallback) ───────────────────────────────────────────
    if (finalResult === null) {
      if (this.objects.size === 0) {
        finalResult = [];
      } else {
        const words = taskDescription.toLowerCase().split(/\s+/);
        const scored = [];

        for (const obj of this.objects.values()) {
          // Apply category filtering
          if (allowedCategories && !allowedCategories.includes(obj.type)) {
            continue;
          }
          let score = 0;
          const text = `${obj.title} ${obj.content} ${obj.tags.join(' ')}`.toLowerCase();

          for (const word of words) {
            if (word.length < 3) continue;
            if (text.includes(word)) score += 1;
            if (obj.title.toLowerCase().includes(word)) score += 3;
            if (obj.tags.some(t => t.includes(word))) score += 2;
          }

          if (score > 0) scored.push({ obj, score });
        }

        // Sort by relevance, trim to token budget.
        scored.sort((a, b) => b.score - a.score);
        const result = [];
        let spent = 0;
        for (const { obj } of scored) {
          const cost = estimateItemTokens(obj);
          if (spent + cost > budget) break;
          result.push(obj);
          spent += cost;
        }
        finalResult = result;
      }
    }

    // Record memory context event if runId exists
    if (options.runId) {
      try {
        const { getLedger } = require('../src/governor/run_ledger');
        const { getActiveAgentContext } = require('../src/governor/agent_registry');
        const agentCtx = taskType ? getActiveAgentContext(taskType) : null;
        let spent = 0;
        for (const item of finalResult) {
          spent += estimateItemTokens(item);
        }
        getLedger().recordMemoryContext({
          runId: options.runId,
          taskType: taskType || null,
          agentId: agentCtx?.agentId || null,
          budgetRequested: maxTokens || null,
          budgetResolved: budget,
          categoriesAllowed: allowedCategories,
          itemsLoaded: finalResult.length,
          tokensUsed: spent,
        });
      } catch (e) {
        // Silently contain ledger recording failures so memory recall is never broken
      }
    }

    return finalResult;
  }

  // Get all objects of a type
  byType(type) {
    if (this.sqliteStore && this.sqliteStore.db) {
      try {
        let category = type || 'context';
        const validCategories = new Set(['decision', 'convention', 'gotcha', 'workflow', 'context']);
        if (!validCategories.has(category)) {
          category = 'context';
        }
        const rows = this.sqliteStore.list({ category });
        if (rows && rows.length > 0) {
          return rows.map(_rowToMemoryObject);
        }
      } catch (e) {
        // Fall back gracefully
      }
    }
    return Array.from(this.objects.values()).filter(o => o.type === type);
  }

  // Get all objects
  all() {
    if (this.sqliteStore && this.sqliteStore.db) {
      try {
        const rows = this.sqliteStore.list();
        if (rows && rows.length > 0) {
          return rows.map(_rowToMemoryObject);
        }
      } catch (e) {
        // Fall back gracefully
      }
    }
    return Array.from(this.objects.values());
  }

  // Get by ID
  get(id) {
    if (this.sqliteStore && this.sqliteStore.db) {
      try {
        const now = this.sqliteStore.config.now();
        const row = this.sqliteStore.db.prepare(
          'SELECT * FROM memories WHERE id = ? AND (expires_at IS NULL OR expires_at >= ?)'
        ).get(id, now);
        if (row) {
          return _rowToMemoryObject(row);
        }
      } catch (e) {
        // Fall back gracefully
      }
    }
    return this.objects.get(id) || null;
  }

  // Delete by ID
  forget(id) {
    const obj = this.get(id);
    if (!obj) return false;

    let deletedFromSqlite = false;
    let deletedFromJson = false;

    // Delete from JSON/in-memory objects if present
    if (this.objects.has(id)) {
      this.objects.delete(id);
      deletedFromJson = true;
    }

    // Delete from SQLite if available
    if (this.sqliteStore) {
      try {
        const deleted = this.sqliteStore.forget(id);
        if (deleted) {
          deletedFromSqlite = true;
        }
      } catch (e) {
        // Dual-delete failure is contained
      }
    }

    // Remove markdown file
    if (obj.type && obj.id) {
      try {
        const filename = `${obj.type}-${obj.id}.md`;
        const filePath = path.join(this.memDir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        // Markdown unlink should be best-effort
      }
    }

    if (deletedFromJson) {
      this.save();
    }

    return deletedFromSqlite || deletedFromJson;
  }


}

// MCP Tool definitions and execution functions are imported from ./memory_helpers

if (typeof formatForContext !== 'function') {
  throw new TypeError('MemoryStore prototype method "formatForContext" in memory_helpers is not a function');
}
if (typeof formatList !== 'function') {
  throw new TypeError('MemoryStore prototype method "formatList" in memory_helpers is not a function');
}
if (typeof stats !== 'function') {
  throw new TypeError('MemoryStore prototype method "stats" in memory_helpers is not a function');
}

MemoryStore.prototype.formatForContext = formatForContext;
MemoryStore.prototype.formatList = formatList;
MemoryStore.prototype.stats = stats;

module.exports = { MemoryStore, MemoryObject, getMemoryTools, executeMemoryTool, renderMemoryForContext };
