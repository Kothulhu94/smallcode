const { ANSI, BOX } = require('./theme');
const { visualWrap, visualLength } = require('./text_layout');

function renderChatPanel(tui) {
  let buf = '';
  if (tui.showWelcome && tui.chatLines.length === 0) {
    return renderWelcomeScreen(tui);
  }

  const startLine = Math.max(0, tui.chatLines.length - tui.chatHeight + tui.chatScroll);
  const endLine = startLine + tui.chatHeight;
  const visible = tui.chatLines.slice(startLine, endLine);

  for (let i = 0; i < tui.chatHeight; i++) {
    buf += ANSI.moveTo(i + 1, 1);
    const line = visible[i] || '';
    buf += tui._truncate(line, tui.chatWidth);
    buf += ' '.repeat(Math.max(0, tui.chatWidth - tui._stripAnsi(line).length));
  }
  return buf;
}

function renderWelcomeScreen(tui) {
  let buf = '';
  const w = tui.chatWidth;
  const h = tui.chatHeight;
  const t = tui.theme;

  const logo = [
    '███████╗███╗   ███╗ █████╗ ██╗     ██╗      ██████╗ ██████╗ ██████╗ ███████╗',
    '██╔════╝████╗ ████║██╔══██╗██║     ██║     ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
    '███████╗██╔████╔██║███████║██║     ██║     ██║     ██║   ██║██║  ██║█████╗  ',
    '╚════██║██║╚██╔╝██║██╔══██║██║     ██║     ██║     ██║   ██║██║  ██║██╔══╝  ',
    '███████║██║ ╚═╝ ██║██║  ██║███████╗███████╗╚██████╗╚██████╔╝██████╔╝███████╗',
    '╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
  ];

  const simpleLogo = [
    '╔═╗┌┬┐┌─┐┬  ┬  ╔═╗┌─┐┌┬┐┌─┐',
    '╚═╗│││├─┤│  │  ║  │ │ ││├┤ ',
    '╚═╝┴ ┴┴ ┴┴─┘┴─┘╚═╝└─┘─┴┘└─┘',
  ];

  const useSimple = w < 80;
  const logoLines = useSimple ? simpleLogo : logo;
  const logoWidth = logoLines[0].length;

  const startRow = Math.max(2, Math.floor(h * 0.15));

  for (let i = 0; i < logoLines.length; i++) {
    const row = startRow + i;
    if (row > h) break;
    const pad = Math.max(0, Math.floor((w - logoWidth) / 2));
    buf += ANSI.moveTo(row, 1);
    buf += ' '.repeat(pad) + t.brand + logoLines[i] + ANSI.reset;
  }

  const versionRow = startRow + logoLines.length + 1;
  const versionText = `v${require('../../package.json').version}`;
  const versionPad = Math.max(0, Math.floor((w - logoWidth) / 2) + logoWidth - versionText.length);
  buf += ANSI.moveTo(versionRow, versionPad + 1);
  buf += t.muted + versionText + ANSI.reset;

  const commands = [
    ['/help', 'show help', 'ctrl+l'],
    ['/model', 'switch model', ''],
    ['/memory', 'project memory', ''],
    ['/skill', 'manage skills', ''],
    ['/quit', 'exit', 'ctrl+c'],
  ];

  const cmdStartRow = versionRow + 3;
  for (let i = 0; i < commands.length; i++) {
    const [cmd, desc, shortcut] = commands[i];
    const row = cmdStartRow + i;
    if (row > h) break;
    const pad = Math.max(0, Math.floor((w - 42) / 2));
    buf += ANSI.moveTo(row, pad + 1);
    buf += (t.cmdHighlight || t.accent) + cmd.padEnd(12) + ANSI.reset;
    buf += t.fg + desc.padEnd(18) + ANSI.reset;
    buf += t.muted + shortcut + ANSI.reset;
  }

  const infoRow = cmdStartRow + commands.length + 2;
  if (infoRow < h) {
    const infoText = `${tui.model}`;
    const infoPad = Math.max(0, Math.floor((w - infoText.length) / 2));
    buf += ANSI.moveTo(infoRow, infoPad + 1);
    buf += t.brandDim + infoText + ANSI.reset;
  }

  return buf;
}

function renderToolPanel(tui) {
  if (tui.toolWidth <= 0) return '';
  let buf = '';
  const col = tui.chatWidth + 1;

  for (let i = 0; i < tui.chatHeight; i++) {
    buf += ANSI.moveTo(i + 1, col);
    buf += tui.theme.border + BOX.vertical + ANSI.reset;
  }

  const startLine = Math.max(0, tui.toolLines.length - tui.chatHeight);
  const visible = tui.toolLines.slice(startLine, startLine + tui.chatHeight);

  for (let i = 0; i < tui.chatHeight; i++) {
    buf += ANSI.moveTo(i + 1, col + 1);
    const line = visible[i] || '';
    buf += tui._truncate(line, tui.toolWidth - 1);
  }

  return buf;
}

function renderInput(tui) {
  let buf = '';
  const row = tui.chatHeight + 1;
  const t = tui.theme;

  if (tui.commandPaletteOpen) {
    buf += renderCommandPalette(tui, row);
  }

  buf += ANSI.moveTo(row, 1);
  buf += t.border + BOX.horizontal.repeat(tui.width) + ANSI.reset;

  const inputAvail = tui.width - 5;
  const inputLines = visualWrap(tui.inputBuffer, inputAvail);

  for (let i = 0; i < inputLines.length && i < 6; i++) {
    buf += ANSI.moveTo(row + 1 + i, 1);
    buf += t.inputBg + t.border + BOX.vertical + ANSI.reset + t.inputBg;
    if (i === 0) {
      buf += t.muted + ' > ' + ANSI.reset + t.inputBg + t.fg;
    } else {
      buf += '   ' + t.inputBg + t.fg;
    }
    buf += inputLines[i];
    const lineVisualLen = visualLength(inputLines[i]);
    buf += ' '.repeat(Math.max(0, inputAvail - lineVisualLen));
    buf += ANSI.reset;
  }

  for (let i = inputLines.length; i < tui.inputHeight - 2; i++) {
    buf += ANSI.moveTo(row + 1 + i, 1);
    buf += ' '.repeat(tui.width);
  }

  const hintRow = row + tui.inputHeight - 1;
  buf += ANSI.moveTo(hintRow, 1);
  if (tui.commandPaletteOpen) {
    buf += t.muted + '  ↑↓ navigate  enter select  esc cancel' + ANSI.reset;
  } else if (inputLines.length > 1) {
    buf += t.muted + `  ${tui.inputBuffer.length} chars` + ANSI.reset;
  } else {
    buf += t.muted + '' + ANSI.reset;
  }

  return buf;
}

function renderCommandPalette(tui, inputRow) {
  let buf = '';
  const filter = tui.inputBuffer.slice(1).toLowerCase();
  const filtered = tui.commands.filter(c =>
    c.cmd.slice(1).startsWith(filter) || (c.alias && c.alias.slice(1).startsWith(filter))
  );

  if (filtered.length === 0) return '';

  tui.commandPaletteSelection = Math.max(0, Math.min(tui.commandPaletteSelection, filtered.length - 1));

  const availableRows = inputRow - 3;
  const maxVisible = Math.max(1, Math.min(filtered.length, availableRows, 12));
  tui._paletteMaxVisible = maxVisible;

  if (tui.commandPaletteSelection < tui._paletteScrollOffset) {
    tui._paletteScrollOffset = tui.commandPaletteSelection;
  } else if (tui.commandPaletteSelection >= tui._paletteScrollOffset + maxVisible) {
    tui._paletteScrollOffset = tui.commandPaletteSelection - maxVisible + 1;
  }
  tui._paletteScrollOffset = Math.max(0, Math.min(tui._paletteScrollOffset, filtered.length - maxVisible));

  const paletteWidth = Math.min(tui.width - 4, 50);
  const startRow = inputRow - maxVisible - 1;
  const hasMore = filtered.length > maxVisible;

  buf += ANSI.moveTo(startRow, 2);
  const countLabel = hasMore ? ` ${tui._paletteScrollOffset + 1}-${Math.min(tui._paletteScrollOffset + maxVisible, filtered.length)}/${filtered.length} ` : '';
  const topFill = paletteWidth - 2 - countLabel.length;
  buf += tui.theme.border + BOX.rTopLeft + BOX.horizontal.repeat(Math.max(0, topFill)) + (hasMore ? tui.theme.muted + countLabel + tui.theme.border : '') + BOX.rTopRight + ANSI.reset;

  for (let i = 0; i < maxVisible; i++) {
    const itemIdx = i + tui._paletteScrollOffset;
    if (itemIdx >= filtered.length) break;
    const cmd = filtered[itemIdx];
    const isSelected = itemIdx === tui.commandPaletteSelection;
    const row = startRow + 1 + i;

    buf += ANSI.moveTo(row, 2);
    buf += tui.theme.border + BOX.vertical + ANSI.reset;

    if (isSelected) buf += ANSI.inverse;

    const cmdText = cmd.cmd + (cmd.alias ? ` (${cmd.alias})` : '');
    const line = ` ${cmdText.padEnd(16)} ${cmd.desc}`;
    buf += (isSelected ? tui.theme.accent : tui.theme.fg) + line.slice(0, paletteWidth - 3).padEnd(paletteWidth - 3);

    if (isSelected) buf += ANSI.reset;
    buf += ANSI.reset + tui.theme.border + BOX.vertical + ANSI.reset;
  }

  buf += ANSI.moveTo(startRow + maxVisible + 1, 2);
  const scrollHint = hasMore && tui._paletteScrollOffset + maxVisible < filtered.length ? ' ↓ more' : '';
  const scrollHintUp = hasMore && tui._paletteScrollOffset > 0 ? ' ↑ ' : '';
  buf += tui.theme.border + BOX.rBottomLeft + BOX.horizontal.repeat(Math.max(0, paletteWidth - 2 - scrollHint.length - scrollHintUp.length));
  if (scrollHintUp) buf += tui.theme.muted + scrollHintUp + tui.theme.border;
  if (scrollHint) buf += tui.theme.muted + scrollHint + tui.theme.border;
  buf += BOX.rBottomRight + ANSI.reset;

  return buf;
}

function renderStatus(tui) {
  let buf = '';
  const row = tui.height;
  const t = tui.theme;

  buf += ANSI.moveTo(row, 1);
  buf += t.statusBg;

  const left = tui.statusMsg
    ? ` ${tui.statusMsg}`
    : ` enter send  shift+drag copy`;
  const scrollInfo = tui.chatScroll < 0 ? `  ↑ scrolled` : '';
  const tokenStr = tui.tokenInfo ? `  ${tui.tokenInfo}` : '';
  const right = ` smallcode  ${tui.model}  ${tui.isStreaming ? '⟳' : '●'} `;
  const padding = tui.width - left.length - scrollInfo.length - tokenStr.length - right.length;

  const leftColor = tui.statusMsg ? (t.accent || t.muted) : t.muted;
  buf += leftColor + left + ANSI.reset + t.statusBg;
  if (scrollInfo) {
    buf += (t.warning || t.muted) + scrollInfo + ANSI.reset + t.statusBg;
  }
  buf += t.muted + tokenStr + ANSI.reset + t.statusBg;
  buf += ' '.repeat(Math.max(1, padding));
  buf += t.brandDim + right + ANSI.reset;

  return buf;
}

module.exports = {
  renderChatPanel,
  renderToolPanel,
  renderInput,
  renderStatus
};
