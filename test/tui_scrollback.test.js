'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FullScreenTUI } = require('../src/tui/fullscreen');
const { handleKeypress } = require('../src/tui/key_handlers');

test('TUI scrollback - basic append and cap', (t) => {
  const tui = new FullScreenTUI({ theme: 'dark' });
  tui.chatHeight = 10; // Mock viewport height

  // 1. Initial state
  assert.equal(tui.chatLines.length, 0);
  assert.equal(tui.chatScroll, 0);

  // 2. Append lines when at bottom
  tui.appendToChatBuffer(Array.from({ length: 15 }, (_, i) => `line ${i}`));
  assert.equal(tui.chatLines.length, 15);
  assert.equal(tui.chatScroll, 0); // Should auto-follow

  // 3. Scroll up
  tui.chatScroll = -2;
  
  // 4. Append more lines while scrolled up
  tui.appendToChatBuffer(['line 15', 'line 16']);
  assert.equal(tui.chatLines.length, 17);
  // chatScroll should be updated to maintain the locked viewport
  assert.equal(tui.chatScroll, -4);

  // 5. Test buffer capping (10000 lines max)
  // Let's mock a smaller max cap for testing by overriding chatScrollMaxLines or using the default maxLines
  // We can temporarily replace the maxLines check or just push 10005 lines
  const linesToPush = Array.from({ length: 10005 }, (_, i) => `line ${i}`);
  tui.chatLines = [];
  tui.chatScroll = -10;
  tui.appendToChatBuffer(linesToPush);

  // The chatLines length should be capped at 10000
  assert.equal(tui.chatLines.length, 10000);
  // The scroll should be adjusted cleanly without underflow
  assert.equal(tui.chatScroll, -9990); // Adjusts to maxBack limit (10000 - 10)
});

test('TUI scrollback - keypress controls', async (t) => {
  const tui = new FullScreenTUI({ theme: 'dark' });
  tui.chatHeight = 10;
  tui.chatLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  tui.chatScroll = 0;

  // Mock render function
  tui.render = () => {};

  // Verify PageUp
  await handleKeypress(tui, '\x1b[5~');
  assert.equal(tui.chatScroll, -10); // PageUp scrolls up by chatHeight (10)

  // Verify Ctrl+U (scroll up half screen)
  await handleKeypress(tui, '\x15');
  assert.equal(tui.chatScroll, -15); // scrolls up by 5 more

  // Verify Ctrl+D (scroll down half screen)
  await handleKeypress(tui, '\x04');
  assert.equal(tui.chatScroll, -10); // scrolls down by 5

  // Verify Home (jump to top of scrollback)
  await handleKeypress(tui, '\x1b[H');
  assert.equal(tui.chatScroll, -40); // 50 lines total - 10 chatHeight = max back is 40

  // Verify End (jump to live bottom)
  await handleKeypress(tui, '\x1b[F');
  assert.equal(tui.chatScroll, 0); // returns to 0
});
