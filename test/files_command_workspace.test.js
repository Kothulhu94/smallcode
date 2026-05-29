// /files Command Workspace Awareness Tests
//
// Verifies:
// 1. getActiveTargetRoot() with no active workspace => { ok: false, reason: 'no_active_workspace' }
// 2. getActiveTargetRoot() with active workspace + valid rootPath => { ok: true, rootPath: '...' }
// 3. getActiveTargetRoot() with active workspace but no rootPath set => { ok: false, reason: 'no_root_path' }
// 4. workspace_create can store rootPath when provided.
// 5. Invalid rootPath (traversal) is rejected.
// 6. Invalid rootPath (relative) is rejected.
// 7. validateTargetRoot validates correctly.
// 8. executeTool workspace_create stores rootPath in manifest.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  getActiveTargetRoot,
  validateTargetRoot,
  getActiveWorkspace,
  setActiveWorkspace,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  getWorkspaceRoot,
  ensureWorkspace,
} = require('../src/governor/project_workspace');

const { executeTool } = require('../bin/executor');
const { getAgent } = require('../src/governor/agent_registry');

const TEST_ID = 'files-cmd-test-ws';

function cleanupTestWorkspace() {
  try {
    const wsRoot = getWorkspaceRoot();
    const activeTxt = path.join(wsRoot, 'active.txt');
    if (fs.existsSync(activeTxt)) {
      const cur = fs.readFileSync(activeTxt, 'utf-8').trim();
      if (cur === TEST_ID) fs.unlinkSync(activeTxt);
    }
    const wsPath = path.join(wsRoot, TEST_ID);
    if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
  } catch {}
}

function makeTempDir() {
  const d = path.join(os.tmpdir(), `files_ws_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ─── Test 1: no active workspace ─────────────────────────────────────────────

test('/files workspace - getActiveTargetRoot with no active workspace', () => {
  cleanupTestWorkspace();

  // Ensure no workspace is active by clearing active.txt for our test ID only
  // We can't easily clear ALL workspaces so we rely on clean state
  // Instead create a temp situation: patch active.txt to blank
  const wsRoot = getWorkspaceRoot();
  const activeTxt = path.join(wsRoot, 'active.txt');
  const originalActive = fs.existsSync(activeTxt) ? fs.readFileSync(activeTxt, 'utf-8') : null;

  try {
    // Write a non-existent workspace ID so getActiveWorkspace() returns null
    // (it validates the manifest exists)
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(activeTxt, 'nonexistent-workspace-xyz-99999', 'utf-8');

    const result = getActiveTargetRoot();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_active_workspace');
  } finally {
    // Restore
    if (originalActive !== null) {
      fs.writeFileSync(activeTxt, originalActive, 'utf-8');
    } else if (fs.existsSync(activeTxt)) {
      fs.unlinkSync(activeTxt);
    }
  }
});

// ─── Test 2: active workspace with valid rootPath ─────────────────────────────

test('/files workspace - getActiveTargetRoot with valid rootPath returns ok:true', () => {
  cleanupTestWorkspace();
  const realDir = makeTempDir();

  try {
    setActiveWorkspace(TEST_ID, { name: 'Files Test', rootPath: realDir });

    const result = getActiveTargetRoot();
    assert.equal(result.ok, true, `Expected ok:true but got: ${JSON.stringify(result)}`);
    assert.equal(result.rootPath, path.resolve(realDir));
    assert.ok(fs.existsSync(result.rootPath), 'rootPath must exist on disk');
  } finally {
    cleanupTestWorkspace();
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

// ─── Test 3: active workspace with no explicit rootPath ───────────────────────

test('/files workspace - getActiveTargetRoot with no rootPath returns no_root_path', () => {
  cleanupTestWorkspace();

  try {
    // Create workspace with no rootPath option → defaults to process.cwd()
    // Then manually clear rootPath in the manifest to simulate "not set"
    setActiveWorkspace(TEST_ID, { name: 'No Root' });

    // Manually null out the rootPath in the manifest
    const manifest = loadWorkspaceManifest(TEST_ID);
    manifest.rootPath = '';
    saveWorkspaceManifest(TEST_ID, manifest);

    const result = getActiveTargetRoot();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_root_path');
  } finally {
    cleanupTestWorkspace();
  }
});

// ─── Test 4: workspace_create stores rootPath when provided ───────────────────

test('/files workspace - workspace_create stores rootPath in manifest', async () => {
  cleanupTestWorkspace();
  const realDir = makeTempDir();

  try {
    const conductor = getAgent('conductor');
    const ctx = { currentTaskType: 'multi_step', activeAgent: conductor, config: {} };

    const result = await executeTool('workspace_create', {
      projectId: TEST_ID,
      name: 'Root Test Workspace',
      rootPath: realDir,
    }, ctx);

    assert.ok(!result.error, `workspace_create must not error: ${result.error}`);
    assert.equal(result.projectId, TEST_ID);

    // Verify rootPath was persisted in project.json
    const manifest = loadWorkspaceManifest(TEST_ID);
    assert.equal(manifest.rootPath, path.resolve(realDir),
      'manifest.rootPath must be the resolved absolute path');
  } finally {
    cleanupTestWorkspace();
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

// ─── Test 5: invalid rootPath (traversal) is rejected ────────────────────────

test('/files workspace - workspace_create rejects traversal in rootPath', async () => {
  cleanupTestWorkspace();

  try {
    const conductor = getAgent('conductor');
    const ctx = { currentTaskType: 'multi_step', activeAgent: conductor, config: {} };

    const result = await executeTool('workspace_create', {
      projectId: TEST_ID,
      name: 'Traversal Test',
      rootPath: 'C:\\Windows\\..\\..\\evil',
    }, ctx);

    // Should fail because rootPath contains traversal sequences
    assert.ok(result.error,
      'workspace_create must return an error for traversal rootPath');
    assert.ok(
      result.error.includes('traversal') || result.error.includes('Invalid rootPath') || result.error.includes('Failed to create workspace'),
      `Error must mention rootPath/traversal issue. Got: ${result.error}`
    );
  } finally {
    cleanupTestWorkspace();
  }
});

// ─── Test 6: invalid rootPath (relative) is rejected ─────────────────────────

test('/files workspace - validateTargetRoot rejects relative paths', () => {
  assert.throws(
    () => validateTargetRoot('relative/path', { mustExist: false }),
    /absolute/,
    'validateTargetRoot must reject relative paths'
  );

  assert.throws(
    () => validateTargetRoot('../sibling', { mustExist: false }),
    /traversal|absolute/,
    'validateTargetRoot must reject traversal paths'
  );

  assert.throws(
    () => validateTargetRoot('', { mustExist: false }),
    /non-empty/,
    'validateTargetRoot must reject empty string'
  );
});

// ─── Test 7: validateTargetRoot accepts valid absolute paths ──────────────────

test('/files workspace - validateTargetRoot validates absolute paths correctly', () => {
  const realDir = makeTempDir();

  try {
    // Valid absolute path that exists
    const resolved = validateTargetRoot(realDir, { mustExist: true });
    assert.equal(resolved, path.resolve(realDir));

    // mustExist:false allows non-existent paths
    const fakePath = path.join(realDir, 'nonexistent-subdir');
    const resolved2 = validateTargetRoot(fakePath, { mustExist: false });
    assert.equal(resolved2, path.resolve(fakePath));

    // Non-existent path with mustExist:true throws
    assert.throws(
      () => validateTargetRoot(fakePath, { mustExist: true }),
      /does not exist/
    );
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

// ─── Test 8: existing project_workspace tests still hold (integration) ────────

test('/files workspace - existing workspace lifecycle still works after changes', () => {
  cleanupTestWorkspace();
  const realDir = makeTempDir();

  try {
    // Create workspace with rootPath
    const wsPath = ensureWorkspace(TEST_ID, {
      name: 'Lifecycle Test',
      rootPath: realDir,
    });

    assert.ok(fs.existsSync(wsPath));

    const manifest = loadWorkspaceManifest(TEST_ID);
    assert.equal(manifest.projectId, TEST_ID);
    assert.equal(manifest.rootPath, path.resolve(realDir));

    // Update manifest without touching rootPath
    manifest.status = 'paused';
    const saved = saveWorkspaceManifest(TEST_ID, manifest);
    assert.equal(saved.status, 'paused');
    assert.equal(saved.rootPath, path.resolve(realDir), 'rootPath must survive saveWorkspaceManifest');

    // getActiveTargetRoot returns no_active_workspace (not set as active yet)
    // (since we used ensureWorkspace not setActiveWorkspace)
    // This is fine — just verify it doesn't crash
    const rootCheck = getActiveTargetRoot();
    assert.ok(typeof rootCheck.ok === 'boolean');
  } finally {
    cleanupTestWorkspace();
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});
