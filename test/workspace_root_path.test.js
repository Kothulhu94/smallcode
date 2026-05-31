'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { executeTool } = require('../bin/executor');
const { getAgent } = require('../src/governor/agent_registry');
const {
  setActiveWorkspace,
  ensureWorkspace,
} = require('../src/governor/project_workspace');
const {
  normalizeWindowsPath,
  safeResolvePath,
  normalizeRelativePathOrPattern
} = require('../src/security/sanitize');

function createTestContext(testWsId) {
  const { getWorkspaceRoot } = require('../src/governor/project_workspace');
  const wsRoot = getWorkspaceRoot();
  const activeTxtPath = path.join(wsRoot, 'active.txt');
  
  let originalActiveVal = null;
  if (fs.existsSync(activeTxtPath)) {
    originalActiveVal = fs.readFileSync(activeTxtPath, 'utf-8').trim();
  }

  // Pre-clean folder
  try {
    const wsPath = path.join(wsRoot, testWsId);
    if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
  } catch {}

  return {
    cleanup: () => {
      try {
        if (originalActiveVal) {
          fs.writeFileSync(activeTxtPath, originalActiveVal, 'utf-8');
        } else {
          if (fs.existsSync(activeTxtPath)) {
            const currentActive = fs.readFileSync(activeTxtPath, 'utf-8').trim();
            if (currentActive === testWsId) {
              fs.unlinkSync(activeTxtPath);
            }
          }
        }
        const wsPath = path.join(wsRoot, testWsId);
        if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('Workspace Root Path - Windows path variants normalization', () => {
  if (process.platform !== 'win32') return;

  assert.equal(normalizeWindowsPath('d:\\NewGame'), 'D:\\NewGame');
  assert.equal(normalizeWindowsPath('D:/NewGame/'), 'D:\\NewGame');
  assert.equal(normalizeWindowsPath('d:/NewGame'), 'D:\\NewGame');
  assert.equal(normalizeWindowsPath('D:\\NewGame\\'), 'D:\\NewGame');
});

test('Workspace Root Path - safeResolvePath casing and trailing slash handling', () => {
  const cwd = process.platform === 'win32' ? 'D:\\NewGame' : '/NewGame';

  // 1. Same-casing relative paths
  const safe1 = safeResolvePath('src/main.ts', cwd);
  assert.equal(safe1.ok, true);
  assert.match(safe1.fullPath, /src[/\\]main\.ts$/);

  // 2. Windows casing mismatched drive letter and slashes
  if (process.platform === 'win32') {
    const safe2 = safeResolvePath('d:/NewGame/src/main.ts', 'D:\\NewGame\\');
    assert.equal(safe2.ok, true);
    assert.equal(safe2.fullPath, 'D:\\NewGame\\src\\main.ts');

    // 3. Absolute path outside the root must be rejected
    const safe3 = safeResolvePath('C:\\Windows\\System32\\cmd.exe', 'D:\\NewGame');
    assert.equal(safe3.ok, false);
    assert.equal(safe3.reason, 'path resolves outside project root');
    
    // 4. Trap: sibling folder containment attack (D:\NewGame2 vs D:\NewGame)
    const safe4 = safeResolvePath('D:\\NewGame2\\main.ts', 'D:\\NewGame');
    assert.equal(safe4.ok, false);
    assert.equal(safe4.reason, 'path resolves outside project root');
  }
});

test('Workspace Root Path - find_files and read_file relative & absolute behavior', async () => {
  const testWsId = 'ws-root-path-find-read-test';
  const tempDir = path.join(os.tmpdir(), `ws_root_path_test_${Date.now()}`);
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'src/main.ts'), 'console.log("hello sci-fi game");');

  const ctx = createTestContext(testWsId);

  try {
    ensureWorkspace(testWsId, { name: 'Root Path Test', rootPath: tempDir });
    setActiveWorkspace(testWsId);

    const codeEditor = getAgent('code_editor');
    const executeCtx = { currentTaskType: 'coding', activeAgent: codeEditor, config: {} };

    // 1. find_files with relative "**/*" glob pattern
    const resultFind1 = await executeTool('find_files', {
      pattern: '**/*'
    }, executeCtx);
    console.log('DEBUG find_files output:', resultFind1);
    console.log('DEBUG tempDir path:', tempDir);
    assert.ok(!resultFind1.error);
    assert.match(resultFind1.result, /src[/\\]main\.ts/);

    // 2. find_files with relative "src/*" pattern
    const resultFind2 = await executeTool('find_files', {
      pattern: 'src/*'
    }, executeCtx);
    assert.ok(!resultFind2.error);
    assert.match(resultFind2.result, /src[/\\]main\.ts/);

    // 3. find_files with absolute path prefix glob pattern (D:/NewGame/src/* equivalent)
    const absolutePattern = path.join(tempDir, 'src/*');
    const resultFind3 = await executeTool('find_files', {
      pattern: absolutePattern
    }, executeCtx);
    assert.ok(!resultFind3.error);
    assert.match(resultFind3.result, /src[/\\]main\.ts/);

    // 4. read_file with relative path
    const resultRead1 = await executeTool('read_file', {
      path: 'src/main.ts'
    }, executeCtx);
    assert.ok(!resultRead1.error);
    assert.match(resultRead1.result, /hello sci-fi game/);

    // 5. read_file with absolute path under root
    const absolutePath = path.join(tempDir, 'src/main.ts');
    const resultRead2 = await executeTool('read_file', {
      path: absolutePath
    }, executeCtx);
    assert.ok(!resultRead2.error);
    assert.match(resultRead2.result, /hello sci-fi game/);

    // 6. read_file with absolute path outside root
    const outsidePath = path.join(os.tmpdir(), `outside_file_${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, 'should be blocked');
    try {
      const resultRead3 = await executeTool('read_file', {
        path: outsidePath
      }, executeCtx);
      assert.ok(resultRead3.error);
      assert.match(resultRead3.error, /path resolves outside project root/);
    } finally {
      try { fs.unlinkSync(outsidePath); } catch {}
    }

  } finally {
    ctx.cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('Workspace Root Path - verify Gemma thinking configurations remain unchanged', () => {
  const conductor = getAgent('conductor');
  const code_editor = getAgent('code_editor');
  const qa_tester = getAgent('qa_tester');
  const architect = getAgent('architect');

  assert.equal(conductor.thinkingEnabled, true);
  assert.equal(code_editor.thinkingEnabled, true);
  assert.equal(qa_tester.thinkingEnabled, true);
  assert.equal(architect.thinkingEnabled, true);

  const repo_navigator = getAgent('repo_navigator');
  assert.notEqual(repo_navigator?.thinkingEnabled, true);
});

test('Workspace Root Path - normalizeRelativePathOrPattern sibling folder check', () => {
  const cwd = process.platform === 'win32' ? 'D:\\NewGame' : '/NewGame';
  const siblingPath = process.platform === 'win32' ? 'D:\\NewGame2\\src\\main.ts' : '/NewGame2/src/main.ts';

  const result = normalizeRelativePathOrPattern(siblingPath, cwd);
  assert.equal(result, siblingPath); // must NOT be stripped or altered
  
  const insidePath = process.platform === 'win32' ? 'D:\\NewGame\\src\\main.ts' : '/NewGame/src/main.ts';
  const result2 = normalizeRelativePathOrPattern(insidePath, cwd);
  assert.equal(result2, 'src/main.ts'); // must be relative
});
