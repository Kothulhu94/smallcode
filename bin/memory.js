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
const crypto = require('crypto');

const MEMORY_DIR = '.smallcode/memory';
const INDEX_FILE = '.smallcode/memory/index.json';

// ─── Memory Object ───────────────────────────────────────────────────────────

class MemoryObject {
  constructor({ id, type, title, content, tags, relations, createdAt, updatedAt, source }) {
    this.id = id || crypto.randomUUID().slice(0, 8);
    this.type = type; // decision | workflow | gotcha | convention | context | source
    this.title = title;
    this.content = content;
    this.tags = tags || [];
    this.relations = relations || []; // { type: "related_to"|"supersedes"|"source_of", target: id }
    this.createdAt = createdAt || new Date().toISOString();
    this.updatedAt = updatedAt || new Date().toISOString();
    this.source = source || null; // { file, line, commit }
  }

  toJSON() {
    return {
      id: this.id, type: this.type, title: this.title, content: this.content,
      tags: this.tags, relations: this.relations,
      createdAt: this.createdAt, updatedAt: this.updatedAt, source: this.source,
    };
  }
}

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
  remember(typeOrObj, title, content, opts = {}) {
    let type, tags, source, relations;
    if (typeOrObj && typeof typeOrObj === 'object') {
      const o = typeOrObj;
      type = o.type;
      title = o.title;
      content = o.content;
      tags = o.tags;
      source = o.source;
      relations = o.relations;
    } else {
      type = typeOrObj;
      tags = opts.tags;
      source = opts.source;
      relations = opts.relations;
    }

    const obj = new MemoryObject({ type, title, content, tags, source, relations });
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
          category,
          text: content || '',
          keywords,
          source: sourceStr
        });
      } catch (e) {
        // Silent fail
      }
    }

    return obj;
  }

  // Load relevant memory for a task (keyword-based retrieval)
  loadForTask(taskDescription) {
    if (this.objects.size === 0) return [];

    const words = taskDescription.toLowerCase().split(/\s+/);
    const scored = [];

    for (const obj of this.objects.values()) {
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

    // Sort by relevance, return top matches
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map(s => s.obj);
  }

  // Get all objects of a type
  byType(type) {
    return Array.from(this.objects.values()).filter(o => o.type === type);
  }

  // Get all objects
  all() {
    return Array.from(this.objects.values());
  }

  // Get by ID
  get(id) {
    return this.objects.get(id) || null;
  }

  // Delete by ID
  forget(id) {
    const obj = this.objects.get(id);
    if (!obj) return false;
    this.objects.delete(id);
    // Remove markdown file
    const filename = `${obj.type}-${obj.id}.md`;
    const filePath = path.join(this.memDir, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    this.save();
    return true;
  }

  // Format memory for context injection (token-efficient)
  formatForContext(objects, maxTokens = 2000) {
    if (!objects || objects.length === 0) return '';

    let output = '<memory>\n';
    let tokens = 0;

    for (const obj of objects) {
      const entry = `[${obj.type}] ${obj.title}: ${obj.content}\n`;
      const entryTokens = Math.ceil(entry.length / 4);
      if (tokens + entryTokens > maxTokens) break;
      output += entry;
      tokens += entryTokens;
    }

    output += '</memory>';
    return output;
  }

  // Format for display
  formatList() {
    const objects = this.all();
    if (objects.length === 0) return '  (no memory objects)';

    const byType = {};
    for (const obj of objects) {
      if (!byType[obj.type]) byType[obj.type] = [];
      byType[obj.type].push(obj);
    }

    let output = '';
    for (const [type, objs] of Object.entries(byType)) {
      output += `  ${type} (${objs.length}):\n`;
      for (const obj of objs) {
        output += `    [${obj.id}] ${obj.title}\n`;
      }
    }
    return output;
  }

  // Get stats
  stats() {
    const types = {};
    for (const obj of this.objects.values()) {
      types[obj.type] = (types[obj.type] || 0) + 1;
    }
    return { total: this.objects.size, byType: types };
  }
}

// ─── MCP Tool Definitions for Memory ─────────────────────────────────────────

function getMemoryTools() {
  return [
    {
      name: 'memory_load',
      description: 'Load relevant project memory/context for a task. Returns decisions, workflows, conventions, and gotchas related to the task.',
      inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'Task description to find relevant memory for' } }, required: ['task'] },
    },
    {
      name: 'memory_remember',
      description: 'Save a durable fact, decision, workflow, or gotcha to project memory. Only save knowledge that should persist across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['decision', 'workflow', 'gotcha', 'convention', 'context', 'source'], description: 'Type of knowledge' },
          title: { type: 'string', description: 'Short title' },
          content: { type: 'string', description: 'The knowledge to remember' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval' },
        },
        required: ['type', 'title', 'content'],
      },
    },
    {
      name: 'memory_list',
      description: 'List all stored memory objects.',
      inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Filter by type (optional)' } } },
    },
    {
      name: 'memory_forget',
      description: 'Delete a memory object by ID.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Memory object ID to delete' } }, required: ['id'] },
    },
  ];
}

// ─── Execute Memory Tool ─────────────────────────────────────────────────────

function executeMemoryTool(store, name, args) {
  switch (name) {
    case 'memory_load': {
      const relevant = store.loadForTask(args.task || '');
      if (relevant.length === 0) return { result: 'No relevant memory found for this task.' };
      const formatted = relevant.map(o => `[${o.type}] ${o.title}\n${o.content}`).join('\n\n');
      return { result: `Loaded ${relevant.length} memory objects:\n\n${formatted}` };
    }
    case 'memory_remember': {
      const obj = store.remember(args.type, args.title, args.content, { tags: args.tags });
      return { result: `Remembered [${obj.type}] "${obj.title}" (id: ${obj.id})` };
    }
    case 'memory_list': {
      const objects = args.type ? store.byType(args.type) : store.all();
      if (objects.length === 0) return { result: 'No memory objects stored.' };
      const list = objects.map(o => `[${o.id}] (${o.type}) ${o.title}`).join('\n');
      return { result: `${objects.length} memory objects:\n${list}` };
    }
    case 'memory_forget': {
      const success = store.forget(args.id);
      return { result: success ? `Deleted memory ${args.id}` : `Memory ${args.id} not found` };
    }
    default:
      return { error: `Unknown memory tool: ${name}` };
  }
}

module.exports = { MemoryStore, MemoryObject, getMemoryTools, executeMemoryTool };
