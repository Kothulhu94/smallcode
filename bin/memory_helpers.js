// SmallCode — Memory Helpers and MemoryObject
// Extracted from bin/memory.js to keep file lengths under 500 lines.

'use strict';

const crypto = require('crypto');

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

// Helper to convert an SQLite row to a MemoryObject
function _rowToMemoryObject(row) {
  let source = null;
  if (row.source) {
    if (typeof row.source === 'string') {
      try {
        source = JSON.parse(row.source);
      } catch (e) {
        source = row.source;
      }
    } else {
      source = row.source;
    }
  }
  return new MemoryObject({
    id: row.id,
    type: row.category,
    title: (row.title && row.title.trim()) ? row.title.trim() : row.text.split('\n')[0].slice(0, 80),
    content: row.text,
    tags: row.keywords ? row.keywords.split(',').map(t => t.trim()).filter(Boolean) : [],
    source: source,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.last_used).toISOString(),
    relations: [],
  });
}

// Helper to render a MemoryObject into a compact format for prompt context
function renderMemoryForContext(obj) {
  if (!obj) return '';

  const rawId = obj.id || '';
  const shortId = rawId.length > 8 ? rawId.slice(0, 8) : rawId;

  let sourceFile = '';
  let sourceLine = '';

  if (obj.source) {
    let sourceObj = null;

    if (typeof obj.source === 'object') {
      sourceObj = obj.source;
    } else if (typeof obj.source === 'string') {
      const trimmed = obj.source.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          sourceObj = JSON.parse(trimmed);
        } catch (e) {
          // not JSON, treat as string
        }
      }
      if (!sourceObj && trimmed) {
        sourceFile = trimmed;
      }
    }

    if (sourceObj) {
      if (sourceObj.file) {
        sourceFile = String(sourceObj.file);
      }
      if (sourceObj.line !== undefined && sourceObj.line !== null) {
        sourceLine = String(sourceObj.line);
      }
    }
  }

  let sourceLabel = '';
  if (sourceFile) {
    const cleanFile = sourceFile.replace(/[\r\n[\]]+/g, '').trim();
    if (cleanFile) {
      const cleanLine = sourceLine ? `:${sourceLine.replace(/[\r\n[\]]+/g, '').trim()}` : '';
      sourceLabel = ` source=${cleanFile}${cleanLine}`;
    }
  }

  let statusPrefix = '';
  if (obj.tags && Array.isArray(obj.tags) && obj.tags.includes('evidence')) {
    if (obj.tags.includes('validation-failed')) {
      statusPrefix = '[VALIDATION_FAILED] ';
    } else if (obj.tags.includes('partial-failure')) {
      statusPrefix = '[PARTIAL_FAILURE] ';
    } else if (obj.tags.includes('success')) {
      statusPrefix = '[SUCCESS] ';
    } else {
      statusPrefix = '[UNKNOWN] ';
    }
  }

  const cleanTitle = (obj.title || '').replace(/[\r\n]+/g, ' ').trim();
  const cleanContent = (obj.content || '').trim();

  return `[${obj.type}:${shortId}${sourceLabel}] ${statusPrefix}${cleanTitle} —\n${cleanContent}\n`;
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
      if (obj.duplicate) {
        return { result: `Already known (confirmed existing: ${obj.existing_id})` };
      }
      if (obj.rejected) {
        return { result: `Rejected: ${obj.reason}` };
      }
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

function formatForContext(objects, maxTokens = 2000) {
  if (!objects || objects.length === 0) return '';

  let output = '<memory>\n';
  let tokens = 0;

  for (const obj of objects) {
    const entry = renderMemoryForContext(obj);
    const entryTokens = Math.ceil(entry.length / 4);
    if (tokens + entryTokens > maxTokens) break;
    output += entry;
    tokens += entryTokens;
  }

  output += '</memory>';
  return output;
}

function formatList() {
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

function stats() {
  if (this.sqliteStore && this.sqliteStore.db) {
    try {
      const rows = this.sqliteStore.list();
      if (rows && rows.length > 0) {
        const types = {};
        for (const row of rows) {
          const mapped = _rowToMemoryObject(row);
          const type = mapped.type;
          types[type] = (types[type] || 0) + 1;
        }
        return { total: rows.length, byType: types };
      }
    } catch (e) {
      // Fall back gracefully
    }
  }
  const types = {};
  for (const obj of this.objects.values()) {
    types[obj.type] = (types[obj.type] || 0) + 1;
  }
  return { total: this.objects.size, byType: types };
}

module.exports = {
  MemoryObject,
  _rowToMemoryObject,
  renderMemoryForContext,
  getMemoryTools,
  executeMemoryTool,
  formatForContext,
  formatList,
  stats
};
