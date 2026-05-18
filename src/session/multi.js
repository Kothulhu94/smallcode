// SmallCode — Multi-Session Manager
// Run parallel agent sessions on different tasks
// Each session is an independent agent loop with its own conversation history
//
// Usage:
//   /session new "task description"     — spawn a new parallel session
//   /session list                       — show all active sessions
//   /session switch <id>                — switch focus to another session
//   /session kill <id>                  — terminate a session

const { fork } = require('child_process');
const path = require('path');
const crypto = require('crypto');

class MultiSessionManager {
  constructor() {
    this.sessions = new Map(); // id → { process, status, title, messages, startedAt }
    this.activeId = null;
  }

  // Create a new session (runs in the same process, separate conversation state)
  create(title) {
    const id = crypto.randomBytes(3).toString('hex');
    const session = {
      id,
      title: title || `Session ${this.sessions.size + 1}`,
      messages: [],
      status: 'active', // active | paused | completed
      startedAt: Date.now(),
      toolCalls: 0,
    };
    this.sessions.set(id, session);
    if (!this.activeId) this.activeId = id;
    return session;
  }

  // Get the active session
  active() {
    return this.sessions.get(this.activeId) || null;
  }

  // Switch to a different session
  switch(id) {
    if (!this.sessions.has(id)) return null;
    this.activeId = id;
    return this.sessions.get(id);
  }

  // List all sessions
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      messages: s.messages.length,
      active: s.id === this.activeId,
      age: Math.floor((Date.now() - s.startedAt) / 1000),
    }));
  }

  // Kill/remove a session
  kill(id) {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    if (this.activeId === id) {
      // Switch to first remaining or null
      const remaining = [...this.sessions.keys()];
      this.activeId = remaining[0] || null;
    }
    return true;
  }

  // Get messages for the active session
  getMessages() {
    const session = this.active();
    return session ? session.messages : [];
  }

  // Push a message to the active session
  pushMessage(msg) {
    const session = this.active();
    if (session) session.messages.push(msg);
  }

  // Get session count
  count() {
    return this.sessions.size;
  }
}

module.exports = { MultiSessionManager };
