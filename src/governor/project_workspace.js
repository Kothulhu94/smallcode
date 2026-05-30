// SmallCode — Project Workspace Layer
// Manages workspace states, layouts, safe path resolution, runs/handoff links,
// and metadata serialization under .smallcode/workspaces/<projectId>.

'use strict';

const fs = require('fs');
const path = require('path');
const { validateTargetRoot, getActiveTargetRoot, diagnoseWorkspaceState } = require('./workspace_diagnostics');

const VALID_KINDS = new Set([
  'tasks', 'plans', 'handoffs', 'artifacts',
  'screenshots', 'runs', 'scratch', 'checkpoints'
]);

/**
 * Normalizes project ID with strict path traversal checks.
 * Rejects hostile path traversal sequences before doing any normalization.
 * @param {string} projectId
 * @returns {string} Normalized ID
 */
function normalizeProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Project ID must be a non-empty string.');
  }

  // Reject path traversal inputs before normalization
  if (projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
    throw new Error(`Invalid project ID "${projectId}": directory traversal or separator characters are not allowed.`);
  }

  let normalized = projectId.trim().toLowerCase()
    .replace(/\s+/g, '-')            // spaces to hyphens
    .replace(/[^a-z0-9\-_]/g, '');   // keep only alphanumeric, hyphen, underscore

  if (!normalized) {
    throw new Error(`Project ID "${projectId}" normalized to an empty string.`);
  }

  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64);
  }

  return normalized;
}

/**
 * Gets the workspace root directory.
 * @returns {string}
 */
function getWorkspaceRoot() {
  return path.join(process.cwd(), '.smallcode', 'workspaces');
}

/**
 * Ensures a project workspace exists.
 * @param {string} projectId
 * @param {object} [options={}]
 * @returns {string} Absolute path to workspace directory
 */
function ensureWorkspace(projectId, options = {}) {
  const normId = normalizeProjectId(projectId);
  const wsRoot = getWorkspaceRoot();
  const wsPath = path.join(wsRoot, normId);

  // Create required folders
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
  }

  for (const kind of VALID_KINDS) {
    const kindPath = path.join(wsPath, kind);
    if (!fs.existsSync(kindPath)) {
      fs.mkdirSync(kindPath, { recursive: true });
    }
  }

  const manifestPath = path.join(wsPath, 'project.json');
  let manifest = {};
  const now = Date.now();

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      manifest = {};
    }
  }

  // Determine rootPath: prefer explicit option, then existing manifest value, then cwd.
  // Validate the option before storing it so we never persist a bad path.
  let resolvedRootPath = manifest.rootPath || process.cwd();
  if (options.rootPath) {
    try {
      // mustExist:false — the target directory may not exist yet on this machine
      resolvedRootPath = validateTargetRoot(options.rootPath, { mustExist: false });
    } catch (e) {
      throw new Error(`Invalid rootPath: ${e.message}`);
    }
  }

  manifest = {
    projectId: normId,
    name: manifest.name || options.name || projectId,
    description: manifest.description || options.description || '',
    createdAt: manifest.createdAt || now,
    updatedAt: now,
    status: manifest.status || 'active',
    rootPath: resolvedRootPath,
    tags: manifest.tags || options.tags || [],
    activeGoal: options.activeGoal || options.goal || manifest.activeGoal || '',
    constraints: manifest.constraints || options.constraints || [],
    lastRunId: manifest.lastRunId || null,
    metadata: { ...(manifest.metadata || {}), ...(options.metadata || {}) }
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Write default project.md
  const mdPath = path.join(wsPath, 'project.md');
  if (!fs.existsSync(mdPath)) {
    const mdContent = `# Project: ${manifest.name}
ID: ${normId}
Created: ${new Date(manifest.createdAt).toISOString()}
Status: ${manifest.status}

## Description
${manifest.description || 'No description provided.'}

## Active Goal
${manifest.activeGoal || 'No active goal set.'}
`;
    fs.writeFileSync(mdPath, mdContent, 'utf-8');
  }

  // Write goals.md
  const goalsPath = path.join(wsPath, 'goals.md');
  if (!fs.existsSync(goalsPath)) {
    const goalLine = manifest.activeGoal ? `- [ ] ${manifest.activeGoal}` : '- [ ] Define project goals';
    fs.writeFileSync(goalsPath, `# Project Goals\n\n${goalLine}\n`, 'utf-8');
  }

  // Write constraints.md
  const constraintsPath = path.join(wsPath, 'constraints.md');
  if (!fs.existsSync(constraintsPath)) {
    let constList = '';
    if (Array.isArray(manifest.constraints) && manifest.constraints.length > 0) {
      constList = manifest.constraints.map(c => `- ${c}`).join('\n') + '\n';
    } else {
      constList = '- Keep it portable\n';
    }
    fs.writeFileSync(constraintsPath, `# Project Constraints\n\n${constList}`, 'utf-8');
  }

  return wsPath;
}

/**
 * Gets the active workspace ID.
 * @returns {string|null}
 */
function getActiveWorkspace() {
  const activeTxt = path.join(getWorkspaceRoot(), 'active.txt');
  if (!fs.existsSync(activeTxt)) return null;

  try {
    const raw = fs.readFileSync(activeTxt, 'utf-8').trim();
    if (!raw) return null;
    const normId = normalizeProjectId(raw);

    // Verify it exists
    const manifestPath = path.join(getWorkspaceRoot(), normId, 'project.json');
    if (!fs.existsSync(manifestPath)) return null;

    return normId;
  } catch (e) {
    return null;
  }
}

/**
 * Sets the active workspace ID.
 * @param {string} projectId
 * @param {object} [options={}]
 * @returns {string} Normalized ID
 */
function setActiveWorkspace(projectId, options = {}) {
  const normId = normalizeProjectId(projectId);
  ensureWorkspace(normId, options);

  const activeTxt = path.join(getWorkspaceRoot(), 'active.txt');
  fs.writeFileSync(activeTxt, normId, 'utf-8');

  return normId;
}

/**
 * Loads the manifest of a workspace.
 * @param {string} projectId
 * @returns {object}
 */
function loadWorkspaceManifest(projectId) {
  const normId = normalizeProjectId(projectId);
  const manifestPath = path.join(getWorkspaceRoot(), normId, 'project.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Workspace "${normId}" manifest not found.`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

/**
 * Saves/updates a workspace's manifest.
 * @param {string} projectId
 * @param {object} manifest
 * @returns {object} Updated manifest
 */
function saveWorkspaceManifest(projectId, manifest) {
  const normId = normalizeProjectId(projectId);
  const manifestPath = path.join(getWorkspaceRoot(), normId, 'project.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Workspace "${normId}" manifest not found.`);
  }

  const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const updated = {
    ...existing,
    ...manifest,
    projectId: normId, // prevent ID overwrite
    updatedAt: Date.now()
  };

  fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/**
 * Lists all valid workspaces.
 * @returns {Array<object>}
 */
function listWorkspaces() {
  const root = getWorkspaceRoot();
  if (!fs.existsSync(root)) return [];

  const items = fs.readdirSync(root);
  const results = [];

  for (const item of items) {
    const itemPath = path.join(root, item);
    if (!fs.statSync(itemPath).isDirectory()) continue;

    const manifestPath = path.join(itemPath, 'project.json');
    if (fs.existsSync(manifestPath)) {
      try {
        results.push(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
      } catch (e) {}
    }
  }

  return results;
}

/**
 * Safely resolves a path relative to a workspace.
 * Throws if the path escapes the workspace directory.
 * @param {string} projectId
 * @param {string} relativePath
 * @returns {string} Absolute resolved path
 */
function resolveWorkspacePath(projectId, relativePath) {
  const normId = normalizeProjectId(projectId);
  const wsDir = path.join(getWorkspaceRoot(), normId);
  const resolved = path.resolve(wsDir, relativePath);

  // Strict check to prevent traversal
  const relative = path.relative(wsDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Directory traversal attempt detected: "${relativePath}" escapes workspace "${normId}".`);
  }

  return resolved;
}

/**
 * Writes an artifact to a workspace folder kind.
 * @param {string} projectId
 * @param {string} kind
 * @param {string} name
 * @param {string|Buffer} contentOrBuffer
 * @returns {string} Absolute resolved path
 */
function writeWorkspaceArtifact(projectId, kind, name, contentOrBuffer) {
  const normId = normalizeProjectId(projectId);
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid workspace artifact kind: "${kind}". Must be one of: ${Array.from(VALID_KINDS).join(', ')}`);
  }

  const safePath = resolveWorkspacePath(normId, path.join(kind, name));
  const parent = path.dirname(safePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  fs.writeFileSync(safePath, contentOrBuffer);
  return safePath;
}

/**
 * Lists artifacts in a kind folder.
 * @param {string} projectId
 * @param {string} kind
 * @returns {Array<string>} List of file names
 */
function listWorkspaceArtifacts(projectId, kind) {
  const normId = normalizeProjectId(projectId);
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid workspace artifact kind: "${kind}".`);
  }

  const kindDir = path.join(getWorkspaceRoot(), normId, kind);
  if (!fs.existsSync(kindDir)) return [];

  return fs.readdirSync(kindDir);
}

/**
 * Links a ledger run to the workspace by writing a reference pointer under runs/.
 * @param {string} projectId
 * @param {string} runId
 * @param {object} [metadata={}]
 */
function linkRunToWorkspace(projectId, runId, metadata = {}) {
  const normId = normalizeProjectId(projectId);
  const pointer = {
    runId,
    createdAt: metadata.createdAt || Date.now(),
    taskType: metadata.taskType || '',
    activeAgentId: metadata.activeAgentId || '',
    modelPreset: metadata.modelPreset || '',
    promptPreview: metadata.promptPreview ? String(metadata.promptPreview).slice(0, 500) : '',
    dashboardUrl: metadata.dashboardUrl || `http://localhost:3000/run/${runId}`
  };

  writeWorkspaceArtifact(normId, 'runs', `${runId}.json`, JSON.stringify(pointer, null, 2));

  // Update lastRunId in manifest
  try {
    const manifest = loadWorkspaceManifest(normId);
    manifest.lastRunId = runId;
    saveWorkspaceManifest(normId, manifest);
  } catch (e) {}
}

/**
 * Links a handoff packet to the workspace by saving a copy under handoffs/.
 * @param {string} projectId
 * @param {object} handoffPacket
 */
function linkHandoffToWorkspace(projectId, handoffPacket) {
  const normId = normalizeProjectId(projectId);
  if (!handoffPacket || !handoffPacket.id) return;

  writeWorkspaceArtifact(normId, 'handoffs', `${handoffPacket.id}.json`, JSON.stringify(handoffPacket, null, 2));
}

/**
 * Compiles a summary of the workspace.
 * @param {string} projectId
 * @returns {object} Summary object
 */
function getWorkspaceSummary(projectId) {
  const normId = normalizeProjectId(projectId);
  const manifest = loadWorkspaceManifest(normId);

  const getCount = (kind) => {
    try {
      const kindDir = path.join(getWorkspaceRoot(), normId, kind);
      if (!fs.existsSync(kindDir)) return 0;
      return fs.readdirSync(kindDir).length;
    } catch (e) {
      return 0;
    }
  };

  let rootPathValid = false;
  if (manifest.rootPath) {
    try {
      validateTargetRoot(manifest.rootPath, { mustExist: true });
      rootPathValid = true;
    } catch (e) {
      rootPathValid = false;
    }
  }

  return {
    projectId: normId,
    name: manifest.name,
    description: manifest.description,
    status: manifest.status,
    activeGoal: manifest.activeGoal,
    rootPath: manifest.rootPath || null,
    rootPathValid,
    taskCount: getCount('tasks'),
    planCount: getCount('plans'),
    runCount: getCount('runs'),
    artifactCount: getCount('artifacts'),
    screenshotCount: getCount('screenshots'),
    handoffCount: getCount('handoffs'),
    updatedAt: manifest.updatedAt
  };
}

// Handled by workspace_diagnostics.js


module.exports = {
  normalizeProjectId,
  getWorkspaceRoot,
  ensureWorkspace,
  getActiveWorkspace,
  setActiveWorkspace,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  listWorkspaces,
  resolveWorkspacePath,
  writeWorkspaceArtifact,
  listWorkspaceArtifacts,
  linkRunToWorkspace,
  linkHandoffToWorkspace,
  getWorkspaceSummary,
  validateTargetRoot,
  getActiveTargetRoot,
  diagnoseWorkspaceState,
};
