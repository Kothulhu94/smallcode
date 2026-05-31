const { ANSI } = require('./theme');
const { highlightCode } = require('./theme');
const { wordWrap } = require('./text_layout');

function addChat(tui, role, content) {
  tui.showWelcome = false;
  const prefix = role === 'user'
    ? tui.theme.accent + ' You: ' + ANSI.reset
    : role === 'assistant'
      ? tui.theme.success + ' AI:  ' + ANSI.reset
      : tui.theme.muted + '      ' + ANSI.reset;
  const contPrefix = '      ';
  const t = tui.theme;

  const rawLines = content.split('\n');
  let inCodeBlock = false;
  const newLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      const p = i === 0 ? prefix : contPrefix;
      if (inCodeBlock) {
        newLines.push(p + t.border + '┌─ ' + t.muted + line.trim().slice(3) + ANSI.reset);
      } else {
        newLines.push(contPrefix + t.border + '└─' + ANSI.reset);
      }
      continue;
    }

    const p = i === 0 ? prefix : contPrefix;
    const maxWidth = tui.chatWidth - 7;

    if (inCodeBlock) {
      const highlighted = highlightCode(line, tui.theme);
      newLines.push(contPrefix + t.border + '│ ' + ANSI.reset + highlighted);
    } else {
      const wrapped = wordWrap(line, maxWidth);
      for (let j = 0; j < wrapped.length; j++) {
        newLines.push((j === 0 ? p : contPrefix) + wrapped[j]);
      }
    }
  }
  newLines.push('');
  tui.appendToChatBuffer(newLines);
  tui.msgCount++;
  tui.render();
}

function addTool(tui, name, status, detail) {
  const icon = status === 'ok' ? tui.theme.success + '✓' :
               status === 'err' ? tui.theme.error + '✗' :
               tui.theme.accent + '⚙';
  const nameStr = name ? tui.theme.accent + name + ANSI.reset + ' ' : '';

  const headerLine = ` ${icon} ${ANSI.reset}${nameStr}`;
  const newLines = [];
  if (detail) {
    const detailLines = String(detail).split('\n');
    for (let i = 0; i < detailLines.length; i++) {
      const dLine = detailLines[i];
      const maxWidth = tui.chatWidth - 5;
      const wrapped = wordWrap(dLine, maxWidth);
      for (let j = 0; j < wrapped.length; j++) {
        if (i === 0 && j === 0) {
          newLines.push(headerLine + tui.theme.muted + wrapped[j] + ANSI.reset);
        } else {
          newLines.push('   ' + tui.theme.muted + wrapped[j] + ANSI.reset);
        }
      }
    }
  } else {
    newLines.push(headerLine);
  }

  tui.appendToChatBuffer(newLines);

  const toolLine = ` ${icon} ${ANSI.reset}${nameStr}${detail ? tui.theme.muted + String(detail).replace(/\n/g, ' ') + ANSI.reset : ''}`;
  tui.toolLines.push(toolLine);
  const MAX_TOOL_LINES = 1000;
  if (tui.toolLines.length > MAX_TOOL_LINES) {
    tui.toolLines.shift();
  }

  tui.render();
}

function addDiff(tui, filePath, oldStr, newStr, lineNum) {
  const t = tui.theme;
  const maxLines = 8;
  const diffLines = [];

  diffLines.push(`${t.border}  ┌─ ${ANSI.reset}${t.accent}${filePath}:${lineNum}${ANSI.reset}`);

  const oldLines = oldStr.split('\n').slice(0, maxLines);
  const newLinesList = newStr.split('\n').slice(0, maxLines);

  for (const line of oldLines) {
    diffLines.push(`${t.border}  │ ${ANSI.reset}${t.error}- ${line}${ANSI.reset}`);
  }
  if (oldStr.split('\n').length > maxLines) {
    diffLines.push(`${t.border}  │ ${ANSI.reset}${t.muted}  ... (${oldStr.split('\n').length - maxLines} more)${ANSI.reset}`);
  }
  for (const line of newLinesList) {
    diffLines.push(`${t.border}  │ ${ANSI.reset}${t.success}+ ${line}${ANSI.reset}`);
  }
  if (newStr.split('\n').length > maxLines) {
    diffLines.push(`${t.border}  │ ${ANSI.reset}${t.muted}  ... (${newStr.split('\n').length - maxLines} more)${ANSI.reset}`);
  }

  diffLines.push(`${t.border}  └─${ANSI.reset}`);

  tui.appendToChatBuffer(diffLines);
  tui.render();
}

function streamToken(tui, token) {
  if (tui.chatLines.length === 0 || !tui._lastLineIsStreaming) {
    tui.appendToChatBuffer([tui.theme.success + ' AI:  ' + ANSI.reset]);
    tui._lastLineIsStreaming = true;
  }
  const lastIdx = tui.chatLines.length - 1;
  const maxWidth = tui.chatWidth - 7;

  const parts = token.split('\n');
  tui.chatLines[lastIdx] += parts[0];

  if (tui._stripAnsi(tui.chatLines[lastIdx]).length > maxWidth) {
    const full = tui.chatLines[lastIdx];
    const prefix = '      ';
    const stripped = tui._stripAnsi(full);
    const wrapped = wordWrap(stripped, maxWidth);
    tui.chatLines[lastIdx] = wrapped[0];
    
    const extra = [];
    for (let w = 1; w < wrapped.length; w++) {
      extra.push(prefix + wrapped[w]);
    }
    tui.appendToChatBuffer(extra);
  }

  if (parts.length > 1) {
    const extra = [];
    for (let i = 1; i < parts.length; i++) {
      extra.push('      ' + parts[i]);
    }
    tui.appendToChatBuffer(extra);
  }

  tui.render();
}

module.exports = {
  addChat,
  addTool,
  addDiff,
  streamToken
};
