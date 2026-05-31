// SmallCode — Full-Screen TUI Runtime
// Zero-dependency alternate-buffer terminal UI
// Uses raw ANSI escape sequences for full terminal control
//
// How it works (same technique as OpenCode/Bubble Tea/vim):
// 1. Enter alternate screen buffer (\x1b[?1049h)
// 2. Enable raw mode (keypresses come in as raw bytes)
// 3. Maintain a virtual framebuffer (2D array of cells)
// 4. On each render, diff the framebuffer and write only changed cells
// 5. On exit, restore the original terminal (\x1b[?1049l)

const { ANSI, BOX, THEMES } = require('./theme');
const { visualLength, visualCursorPosition, stripAnsi, truncateString } = require('./text_layout');
const { handleKeypress } = require('./key_handlers');
const { renderChatPanel, renderToolPanel, renderInput, renderStatus } = require('./renderers');
const { addChat, addTool, addDiff, streamToken } = require('./pane_helpers');

class FullScreenTUI {
  constructor(options = {}) {
    this.theme = THEMES[options.theme || 'dark'];
    this.showToolPanel = options.showToolPanel || false;
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    this.chatLines = [];
    this.toolLines = [];
    this.inputBuffer = '';
    this.inputCursor = 0;
    this.chatScroll = 0;
    this.inputHistory = [];
    this.historyIdx = -1;

    this.commandPaletteOpen = false;
    this.commandPaletteSelection = 0;
    this._paletteScrollOffset = 0;
    this.commands = [
      { cmd: '/quit', alias: '/q', desc: 'Exit SmallCode' },
      { cmd: '/clear', alias: null, desc: 'Reset conversation' },
      { cmd: '/model', alias: null, desc: 'Show/switch model' },
      { cmd: '/endpoint', alias: null, desc: 'Switch API endpoint' },
      { cmd: '/stats', alias: null, desc: 'Session statistics' },
      { cmd: '/tokens', alias: null, desc: 'Token usage report' },
      { cmd: '/budget', alias: null, desc: 'Context window budget' },
      { cmd: '/files', alias: null, desc: 'List project files' },
      { cmd: '/diff', alias: null, desc: 'Git diff summary' },
      { cmd: '/git', alias: null, desc: 'Run git command' },
      { cmd: '/loop', alias: null, desc: 'Validate + auto-fix file' },
      { cmd: '/memory', alias: null, desc: 'View project memory' },
      { cmd: '/trace', alias: null, desc: 'View execution traces' },
      { cmd: '/eval', alias: null, desc: 'Run prompt evaluation' },
      { cmd: '/escalation', alias: null, desc: 'Model escalation status' },
      { cmd: '/profile', alias: null, desc: 'Model profile + routing' },
      { cmd: '/cognition', alias: null, desc: 'MarrowScript cognition status' },
      { cmd: '/mcp', alias: null, desc: 'Connected MCP servers' },
      { cmd: '/skill', alias: null, desc: 'Manage reusable skills' },
      { cmd: '/plugin', alias: null, desc: 'Manage plugins' },
      { cmd: '/sessions', alias: null, desc: 'List/resume sessions' },
      { cmd: '/session', alias: null, desc: 'Parallel sessions' },
      { cmd: '/share', alias: null, desc: 'Export session' },
      { cmd: '/undo', alias: null, desc: 'Revert last edit' },
      { cmd: '/compact', alias: null, desc: 'Trim conversation history' },
      { cmd: '/help', alias: null, desc: 'Show all commands' },
      { cmd: '/version', alias: null, desc: 'Show SmallCode version' },
    ];

    this.statusHeight = 1;
    this.inputHeight = 3;
    this.chatHeight = 0;
    this.chatWidth = 0;
    this.toolWidth = 0;

    this.active = false;
    this.model = options.model || 'unknown';
    this.tokenCount = 0;
    this.msgCount = 0;
    this.isStreaming = false;
    this.showWelcome = true;

    this.onSubmit = options.onSubmit || (() => {});
    this.onCommand = options.onCommand || (() => {});
    this.onExit = options.onExit || (() => {});

    this._computeLayout();
  }

  enter() {
    this.active = true;
    this._rawWrite = process.stdout.write.bind(process.stdout);
    this._rawWrite(ANSI.enterAlt + ANSI.hideCursor + '\x1b[?1000h' + '\x1b[?1006h' + '\x1b[?2004h');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.on('resize', () => this._onResize());
    process.stdin.on('data', (data) => this._onKeypress(data));
    this._computeLayout();
    this.render();
  }

  leave() {
    this.active = false;
    const write = this._rawWrite || process.stdout.write.bind(process.stdout);
    write(ANSI.showCursor + '\x1b[?1000l' + '\x1b[?1006l' + '\x1b[?2004l' + ANSI.leaveAlt + ANSI.reset);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  _computeLayout() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;

    const inputAvail = this.width - 5;
    const inputVisualLen = visualLength(this.inputBuffer);
    const wrappedLines = inputAvail > 0 ? Math.ceil(Math.max(1, inputVisualLen) / inputAvail) : 1;
    this.inputHeight = Math.min(8, Math.max(3, wrappedLines + 2));
    this.chatHeight = this.height - this.inputHeight - this.statusHeight;

    if (this.showToolPanel && this.width > 100) {
      this.chatWidth = Math.floor(this.width * 0.65);
      this.toolWidth = this.width - this.chatWidth - 1;
    } else {
      this.chatWidth = this.width;
      this.toolWidth = 0;
    }
  }

  render() {
    if (!this.active) return;
    this._computeLayout();

    let buf = '';
    buf += ANSI.clearScreen + ANSI.moveTo(1, 1);
    buf += renderChatPanel(this);

    if (this.toolWidth > 0) {
      buf += renderToolPanel(this);
    }

    buf += renderInput(this);
    buf += renderStatus(this);

    const inputAvail = this.width - 5;
    const pos = visualCursorPosition(this.inputBuffer, this.inputCursor, inputAvail);
    const inputRow = this.chatHeight + 2 + pos.line;
    const inputCol = 5 + pos.col;
    buf += ANSI.moveTo(inputRow, inputCol) + ANSI.showCursor;

    this._rawWrite(buf);
  }

  setStatus(msg) {
    this.statusMsg = msg || '';
    this.render();
  }

  async _onKeypress(data) {
    await handleKeypress(this, data);
  }

  _onResize() {
    this._computeLayout();
    this.render();
  }

  addChat(role, content) { addChat(this, role, content); }
  addTool(name, status, detail) { addTool(this, name, status, detail); }
  addDiff(filePath, oldStr, newStr, lineNum) { addDiff(this, filePath, oldStr, newStr, lineNum); }

  setStreaming(streaming) {
    this.isStreaming = streaming;
    this.render();
  }

  setModel(name) {
    this.model = name;
    this.render();
  }

  setTokenInfo(info) {
    this.tokenInfo = info || '';
    this.render();
  }

  streamToken(token) { streamToken(this, token); }

  endStream() {
    this._lastLineIsStreaming = false;
    this.appendToChatBuffer(['']);
    this.render();
  }

  appendToChatBuffer(lines) {
    if (typeof lines === 'string') {
      lines = lines.split('\n');
    }
    const n = lines.length;
    if (n === 0) return;

    const atBottom = this.chatScroll === 0;
    this.chatLines.push(...lines);

    if (!atBottom) {
      this.chatScroll -= n;
    }

    const maxLines = 10000;
    if (this.chatLines.length > maxLines) {
      const overflow = this.chatLines.length - maxLines;
      this.chatLines.splice(0, overflow);
      if (this.chatScroll < 0) {
        this.chatScroll = Math.min(0, this.chatScroll + overflow);
      }
    }

    const maxBack = -Math.max(0, this.chatLines.length - (this.chatHeight || 20));
    if (this.chatScroll < maxBack) {
      this.chatScroll = maxBack;
    }
  }

  _truncate(str, maxLen) { return truncateString(str, maxLen); }
  _stripAnsi(str) { return stripAnsi(str); }
}

module.exports = { FullScreenTUI, ANSI, BOX, THEMES };
