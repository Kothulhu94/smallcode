const ESC = '\x1b[';
const ANSI = {
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  moveTo: (row, col) => `${ESC}${row};${col}H`,
  clearScreen: `${ESC}2J`,
  clearLine: `${ESC}2K`,
  setScrollRegion: (top, bottom) => `${ESC}${top};${bottom}r`,
  resetScrollRegion: `${ESC}r`,
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  fg: (n) => `${ESC}38;5;${n}m`,
  bg: (n) => `${ESC}48;5;${n}m`,
  fgRgb: (r, g, b) => `${ESC}38;2;${r};${g};${b}m`,
  bgRgb: (r, g, b) => `${ESC}48;2;${r};${g};${b}m`,
};

const THEMES = {
  dark: {
    bg: ANSI.bgRgb(15, 15, 15),
    fg: ANSI.fgRgb(190, 190, 195),
    accent: ANSI.fgRgb(180, 180, 185),
    muted: ANSI.fgRgb(90, 90, 100),
    success: ANSI.fgRgb(140, 200, 140),
    error: ANSI.fgRgb(220, 90, 90),
    warning: ANSI.fgRgb(220, 180, 80),
    border: ANSI.fgRgb(50, 50, 55),
    statusBg: ANSI.bgRgb(20, 20, 22),
    inputBg: ANSI.bgRgb(18, 18, 20),
    brand: ANSI.fgRgb(220, 220, 225),
    brandDim: ANSI.fgRgb(120, 120, 130),
    cmdHighlight: ANSI.fgRgb(160, 140, 200),
  },
  light: {
    bg: ANSI.bgRgb(250, 250, 252),
    fg: ANSI.fgRgb(30, 30, 40),
    accent: ANSI.fgRgb(60, 60, 70),
    muted: ANSI.fgRgb(140, 140, 160),
    success: ANSI.fgRgb(20, 160, 60),
    error: ANSI.fgRgb(200, 40, 40),
    warning: ANSI.fgRgb(180, 130, 0),
    border: ANSI.fgRgb(200, 200, 210),
    statusBg: ANSI.bgRgb(235, 235, 240),
    inputBg: ANSI.bgRgb(245, 245, 248),
    brand: ANSI.fgRgb(40, 40, 50),
    brandDim: ANSI.fgRgb(120, 120, 130),
    cmdHighlight: ANSI.fgRgb(100, 80, 160),
  },
  minimal: {
    bg: '',
    fg: '',
    accent: ANSI.fg(250),
    muted: ANSI.fg(242),
    success: ANSI.fg(78),
    error: ANSI.fg(196),
    warning: ANSI.fg(214),
    border: ANSI.fg(236),
    statusBg: ANSI.bg(233),
    inputBg: ANSI.bg(234),
    brand: ANSI.fg(255),
    brandDim: ANSI.fg(245),
    cmdHighlight: ANSI.fg(141),
  },
};

const BOX = {
  topLeft: '┌', topRight: '┐',
  bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│',
  teeLeft: '├', teeRight: '┤',
  teeTop: '┬', teeBottom: '┴',
  cross: '┼',
  rTopLeft: '╭', rTopRight: '╮',
  rBottomLeft: '╰', rBottomRight: '╯',
};

function highlightCode(line, theme) {
  let hl = line;
  hl = hl.replace(/(["'`])(?:(?!\1).)*\1/g, m => ANSI.fgRgb(140, 200, 120) + m + ANSI.reset);
  hl = hl.replace(/(\/\/.*)$/, m => theme.muted + m + ANSI.reset);
  hl = hl.replace(/(#.*)$/, m => theme.muted + m + ANSI.reset);
  const kws = ['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','true','false','null','undefined','pub','fn','struct','impl','mut','match','def','self','None','type','interface','enum'];
  for (const kw of kws) {
    hl = hl.replace(new RegExp(`\\b${kw}\\b`, 'g'), ANSI.fgRgb(180, 140, 220) + kw + ANSI.reset);
  }
  hl = hl.replace(/\b(\d+)\b/g, ANSI.fgRgb(120, 200, 220) + '$1' + ANSI.reset);
  return hl;
}

module.exports = { ANSI, THEMES, BOX, highlightCode };
