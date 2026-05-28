const fs = require('fs');
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = null;
}

class MemoryStore {
  constructor(rootDir = process.cwd()) {
    this.rootDir = rootDir;
    this.memDir = path.join(this.rootDir, '.smallcode', 'memory');
    if (!fs.existsSync(this.memDir)) {
      fs.mkdirSync(this.memDir, { recursive: true });
    }
    this.dbPath = path.join(this.memDir, 'memory.db');

    if (Database) {
      try {
        this.db = new Database(this.dbPath);
        this.initDb();
      } catch (e) {
        this.db = null;
      }
    } else {
      this.db = null;
    }
  }

  initDb() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        content TEXT,
        tags TEXT
      )
    `);
  }

  saveMemory({ id, type, title, content, tags }) {
    const memoryId = id || require('crypto').randomUUID().slice(0, 8);
    const mem = { id: memoryId, type, title, content, tags: tags ? JSON.stringify(tags) : '[]' };

    if (this.db) {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO memories (id, type, title, content, tags) VALUES (@id, @type, @title, @content, @tags)');
      stmt.run(mem);
    }
    return { ...mem, tags: tags || [] };
  }

  forget(id) {
    if (this.db) {
      const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
      const info = stmt.run(id);
      return info.changes > 0;
    }
    return false;
  }
}

module.exports = { MemoryStore };
