const { ANSI } = require('./theme');

function visualWidth(ch) {
  const cp = ch.codePointAt(0);
  if (!cp) return 0;
  if (cp >= 0x1100 && (
    cp <= 0x115F ||
    (cp >= 0x2E80 && cp <= 0xA4CF) ||
    (cp >= 0xA960 && cp <= 0xA97C) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE10 && cp <= 0xFE19) ||
    (cp >= 0xFE30 && cp <= 0xFE6F) ||
    (cp >= 0xFF01 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x2FFFF) ||
    (cp >= 0x30000 && cp <= 0x3FFFF)
  )) return 2;
  return 1;
}

function visualLength(str) {
  let len = 0;
  for (const ch of str) len += visualWidth(ch);
  return len;
}

function visualWrap(str, maxVisualWidth) {
  if (str.length === 0) return [''];
  const lines = [];
  let current = '';
  let curWidth = 0;
  for (const ch of str) {
    const w = visualWidth(ch);
    if (curWidth + w > maxVisualWidth) {
      lines.push(current);
      current = ch;
      curWidth = w;
    } else {
      current += ch;
      curWidth += w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function visualCursorPosition(str, cursorIdx, maxVisualWidth) {
  let line = 0;
  let col = 0;
  let charIdx = 0;
  for (const ch of str) {
    if (charIdx >= cursorIdx) break;
    const w = visualWidth(ch);
    if (col + w > maxVisualWidth) {
      line++;
      col = 0;
    }
    col += w;
    charIdx++;
  }
  return { line, col };
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function truncateString(str, maxLen) {
  const stripped = stripAnsi(str);
  if (stripped.length <= maxLen) return str;
  return str.slice(0, maxLen + (str.length - stripped.length)) + ANSI.reset;
}

function wordWrap(text, maxWidth) {
  if (maxWidth <= 0) maxWidth = 40;
  if (!text || stripAnsi(text).length <= maxWidth) return [text || ''];

  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const testLine = current ? current + ' ' + word : word;
    if (stripAnsi(testLine).length <= maxWidth) {
      current = testLine;
    } else {
      if (current) lines.push(current);
      if (stripAnsi(word).length > maxWidth) {
        let remaining = word;
        while (stripAnsi(remaining).length > maxWidth) {
          lines.push(remaining.slice(0, maxWidth));
          remaining = remaining.slice(maxWidth);
        }
        current = remaining;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

module.exports = {
  visualWidth,
  visualLength,
  visualWrap,
  visualCursorPosition,
  stripAnsi,
  truncateString,
  wordWrap
};
