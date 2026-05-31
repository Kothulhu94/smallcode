async function handleKeypress(tui, data) {
  const key = data.toString();

  if (key.includes('\x1b[200~')) {
    const cleaned = key.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
    if (cleaned.length > 0) {
      const printable = cleaned.split('').filter(c => c.charCodeAt(0) >= 32 || c === '\n').join('');
      const text = printable.replace(/\n/g, ' ');
      tui.inputBuffer = tui.inputBuffer.slice(0, tui.inputCursor) + text + tui.inputBuffer.slice(tui.inputCursor);
      tui.inputCursor += text.length;
      tui.commandPaletteOpen = tui.inputBuffer.startsWith('/');
      tui.render();
    }
    return;
  }

  if (key === '\x03') {
    tui.leave();
    tui.onExit();
    return;
  }


  if (key === '\r' || key === '\n') {
    if (tui.commandPaletteOpen) {
      const filter = tui.inputBuffer.slice(1).toLowerCase();
      const filtered = tui.commands.filter(c =>
        c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
      );
      if (filtered.length > 0) {
        const selected = filtered[Math.min(tui.commandPaletteSelection, filtered.length - 1)];
        tui.inputBuffer = selected.cmd;
        tui.inputCursor = tui.inputBuffer.length;
      }
      tui.commandPaletteOpen = false;
      tui.commandPaletteSelection = 0;
      tui._paletteScrollOffset = 0;
    }

    const input = tui.inputBuffer.trim();
    if (input) {
      tui.inputHistory.push(input);
      tui.historyIdx = tui.inputHistory.length;
      tui.inputBuffer = '';
      tui.inputCursor = 0;

      if (input.startsWith('/')) {
        await tui.onCommand(input);
      } else {
        tui.addChat('user', input);
        await tui.onSubmit(input);
      }
    }
    tui.render();
    return;
  }

  if (key === '\x1b' && tui.commandPaletteOpen) {
    tui.commandPaletteOpen = false;
    tui.commandPaletteSelection = 0;
    tui._paletteScrollOffset = 0;
    tui.render();
    return;
  }

  if (key === '\x7f' || key === '\b') {
    if (tui.inputCursor > 0) {
      tui.inputBuffer = tui.inputBuffer.slice(0, tui.inputCursor - 1) + tui.inputBuffer.slice(tui.inputCursor);
      tui.inputCursor--;
    }
    if (tui.inputBuffer.startsWith('/') && tui.inputBuffer.length > 0) {
      tui.commandPaletteOpen = true;
    } else {
      tui.commandPaletteOpen = false;
      tui.commandPaletteSelection = 0;
    }
    tui.render();
    return;
  }

  if (key === '\x1b[A') {
    if (tui.commandPaletteOpen) {
      tui.commandPaletteSelection = Math.max(0, tui.commandPaletteSelection - 1);
      if (tui.commandPaletteSelection < tui._paletteScrollOffset) {
        tui._paletteScrollOffset = tui.commandPaletteSelection;
      }
      tui.render();
      return;
    }
    if (tui.historyIdx > 0) {
      tui.historyIdx--;
      tui.inputBuffer = tui.inputHistory[tui.historyIdx] || '';
      tui.inputCursor = tui.inputBuffer.length;
    }
    tui.render();
    return;
  }
  if (key === '\x1b[B') {
    if (tui.commandPaletteOpen) {
      const filter = tui.inputBuffer.slice(1).toLowerCase();
      const filteredLen = tui.commands.filter(c =>
        c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
      ).length;
      tui.commandPaletteSelection = Math.min(filteredLen - 1, tui.commandPaletteSelection + 1);
      const maxVis = tui._paletteMaxVisible || 8;
      if (tui.commandPaletteSelection >= tui._paletteScrollOffset + maxVis) {
        tui._paletteScrollOffset = tui.commandPaletteSelection - maxVis + 1;
      }
      tui.render();
      return;
    }
    if (tui.historyIdx < tui.inputHistory.length - 1) {
      tui.historyIdx++;
      tui.inputBuffer = tui.inputHistory[tui.historyIdx] || '';
    } else {
      tui.historyIdx = tui.inputHistory.length;
      tui.inputBuffer = '';
    }
    tui.inputCursor = tui.inputBuffer.length;
    tui.render();
    return;
  }
  if (key === '\x1b[C') {
    if (tui.inputCursor < tui.inputBuffer.length) tui.inputCursor++;
    tui.render();
    return;
  }
  if (key === '\x1b[D') {
    if (tui.inputCursor > 0) tui.inputCursor--;
    tui.render();
    return;
  }

  if (key === '\x1b[5~' || key === '\x1b[1;2A') {
    const maxBack = -(Math.max(0, tui.chatLines.length - tui.chatHeight));
    const step = key === '\x1b[1;2A' ? 3 : tui.chatHeight;
    tui.chatScroll = Math.max(maxBack, tui.chatScroll - step);
    tui.render();
    return;
  }
  if (key === '\x1b[6~' || key === '\x1b[1;2B') {
    const step = key === '\x1b[1;2B' ? 3 : tui.chatHeight;
    tui.chatScroll = Math.min(0, tui.chatScroll + step);
    tui.render();
    return;
  }
  if (key === '\x15') {
    const maxBack = -(Math.max(0, tui.chatLines.length - tui.chatHeight));
    const step = Math.floor(tui.chatHeight / 2);
    tui.chatScroll = Math.max(maxBack, tui.chatScroll - step);
    tui.render();
    return;
  }
  if (key === '\x04') {
    const step = Math.floor(tui.chatHeight / 2);
    tui.chatScroll = Math.min(0, tui.chatScroll + step);
    tui.render();
    return;
  }
  if (key === '\x1b[H' || key === '\x1b[1~' || key === '\x1bOH') {
    const maxBack = -(Math.max(0, tui.chatLines.length - tui.chatHeight));
    tui.chatScroll = maxBack;
    tui.render();
    return;
  }
  if (key === '\x1b[F' || key === '\x1b[4~' || key === '\x1bOF') {
    tui.chatScroll = 0;
    tui.render();
    return;
  }
  if (key.startsWith('\x1b[<64;')) {
    const maxBack = -(Math.max(0, tui.chatLines.length - tui.chatHeight));
    tui.chatScroll = Math.max(maxBack, tui.chatScroll - 3);
    tui.render();
    return;
  }
  if (key.startsWith('\x1b[<65;')) {
    tui.chatScroll = Math.min(0, tui.chatScroll + 3);
    tui.render();
    return;
  }

  if (key === '\x0c') {
    tui.render();
    return;
  }

  if (key === '\x16') {
    try {
      const { execSync } = require('child_process');
      let clipboard = '';
      if (process.platform === 'win32') {
        clipboard = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8', timeout: 3000 }).trim();
      } else if (process.platform === 'darwin') {
        clipboard = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 }).trim();
      } else {
        clipboard = execSync('xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
      }
      if (clipboard) {
        const text = clipboard.replace(/[\r\n]+/g, ' ');
        tui.inputBuffer = tui.inputBuffer.slice(0, tui.inputCursor) + text + tui.inputBuffer.slice(tui.inputCursor);
        tui.inputCursor += text.length;
        tui.commandPaletteOpen = tui.inputBuffer.startsWith('/');
        tui.render();
      }
    } catch {}
    return;
  }

  if (key.length >= 1 && !key.startsWith('\x1b')) {
    const text = key.replace(/[\x00-\x1f\x7f]/g, '');
    if (text.length > 0) {
      tui.inputBuffer = tui.inputBuffer.slice(0, tui.inputCursor) + text + tui.inputBuffer.slice(tui.inputCursor);
      tui.inputCursor += text.length;

      if (tui.inputBuffer.startsWith('/')) {
        tui.commandPaletteOpen = true;
        tui.commandPaletteSelection = 0;
        tui._paletteScrollOffset = 0;
      } else {
        tui.commandPaletteOpen = false;
        tui._paletteScrollOffset = 0;
      }

      tui.render();
    }
  }
}

module.exports = { handleKeypress };
