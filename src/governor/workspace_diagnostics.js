// SmallCode — Workspace Diagnostics & Validation Helper
// Contains functions moved from project_workspace.js to keep that file under 500 lines.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Validates a candidate rootPath for a workspace target.
 * Accepts absolute Windows/POSIX paths; rejects traversal sequences,
 * non-string values, and (optionally) non-existent paths.
 *
 * @param {string} rootPath
 * @param {object} [opts={}]
 * @param {boolean} [opts.mustExist=true] - When true, throws if path does not exist on disk.
 * @returns {string} Normalized absolute path (path.resolve applied)
 * @throws {Error} With a descriptive message on any validation failure
 */
function validateTargetRoot(rootPath, opts = {}) {
  const mustExist = opts.mustExist !== false;

  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new Error('rootPath must be a non-empty string.');
  }

  // Reject path traversal sequences before resolve()
  if (rootPath.includes('..')) {
    throw new Error(`rootPath contains directory traversal sequence: "${rootPath}".`);
  }

  // Must be absolute
  if (!path.isAbsolute(rootPath)) {
    throw new Error(`rootPath must be an absolute path. Got: "${rootPath}".`);
  }

  const resolved = path.resolve(rootPath);

  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`rootPath does not exist on disk: "${resolved}".`);
  }

  if (mustExist && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`rootPath is not a directory: "${resolved}".`);
  }

  return resolved;
}

/**
 * Returns the target project root for the active workspace.
 *
 * @returns {{ ok: boolean, rootPath?: string, reason?: string, detail?: string }}
 */
function getActiveTargetRoot() {
  const { getActiveWorkspace, loadWorkspaceManifest } = require('./project_workspace');
  const activeId = getActiveWorkspace();
  if (!activeId) {
    return { ok: false, reason: 'no_active_workspace' };
  }

  let manifest;
  try {
    manifest = loadWorkspaceManifest(activeId);
  } catch (e) {
    return { ok: false, reason: 'invalid_root_path', detail: e.message };
  }

  const storedRoot = manifest.rootPath;
  if (!storedRoot || typeof storedRoot !== 'string' || !storedRoot.trim()) {
    return { ok: false, reason: 'no_root_path' };
  }

  try {
    const validRoot = validateTargetRoot(storedRoot, { mustExist: true });
    return { ok: true, rootPath: validRoot };
  } catch (e) {
    return { ok: false, reason: 'invalid_root_path', detail: e.message };
  }
}

/**
 * Diagnoses the workspace state.
 * @returns {object} Diagnostic details
 */
function diagnoseWorkspaceState() {
  const { getWorkspaceRoot, listWorkspaces } = require('./project_workspace');
  const wsRoot = getWorkspaceRoot();
  const activeTxt = path.join(wsRoot, 'active.txt');
  const activeExists = fs.existsSync(activeTxt);
  
  let activeId = null;
  let activeFolderExists = false;
  if (activeExists) {
    try {
      activeId = fs.readFileSync(activeTxt, 'utf-8').trim();
      if (activeId) {
        const activeFolder = path.join(wsRoot, activeId);
        activeFolderExists = fs.existsSync(activeFolder);
      }
    } catch (e) {}
  }
  
  // Available workspaces
  const workspaces = listWorkspaces();
  const availableIds = workspaces.map(w => w.projectId);
  
  // Find duplicate-like/similar IDs
  // Canonical comparison helper
  const canonical = (id) => id.toLowerCase().replace(/[-_]/g, '');
  const duplicates = [];
  const processed = new Set();
  
  for (const id of availableIds) {
    const canon = canonical(id);
    const similar = availableIds.filter(other => other !== id && canonical(other) === canon);
    if (similar.length > 0 && !processed.has(canon)) {
      duplicates.push([id, ...similar]);
      processed.add(canon);
    }
  }
  
  let recommendation = '';
  if (activeId) {
    if (!activeFolderExists) {
      recommendation = `Active workspace ID "${activeId}" is set in active.txt, but its workspace folder does not exist. Use workspace_create with projectId "${activeId}" to recreate it, or use workspace_set_active with an existing one.`;
    } else {
      recommendation = `Active workspace is set and exists: "${activeId}".`;
    }
  } else {
    if (availableIds.length > 0) {
      recommendation = `No active workspace is set. Use workspace_set_active with one of these project IDs to restore state: ${availableIds.join(', ')}.`;
    } else {
      recommendation = `No workspaces exist. Use workspace_create to create a new workspace.`;
    }
  }
  
  return {
    activeTxtExists: activeExists,
    activeIdFromActiveTxt: activeId,
    activeFolderExists,
    availableWorkspaceIds: availableIds,
    duplicates,
    recommendation
  };
}

module.exports = {
  validateTargetRoot,
  getActiveTargetRoot,
  diagnoseWorkspaceState,
};
