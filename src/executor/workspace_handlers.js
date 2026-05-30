const path = require('path');
const fs = require('fs');

async function handleWorkspaceCreate(args, ctx) {
  try {
    const { setActiveWorkspace, getWorkspaceSummary, normalizeProjectId, listWorkspaces } = require('../governor/project_workspace');
    const normId = normalizeProjectId(args.projectId);

    const canonical = (id) => id.toLowerCase().replace(/[-_]/g, '');
    const normCanonical = canonical(normId);

    const existing = listWorkspaces();
    const duplicate = existing.find(w => canonical(w.projectId) === normCanonical);

    if (duplicate) {
      if (duplicate.projectId === normId) {
        return { error: `Workspace "${normId}" already exists. Use workspace_set_active to make it active instead of creating a duplicate.` };
      } else {
        return { error: `Workspace with a similar name already exists: "${duplicate.projectId}". Use workspace_set_active to use it instead of creating a duplicate.` };
      }
    }

    const activeId = setActiveWorkspace(normId, {
      name: args.name,
      description: args.description,
      goal: args.goal,
      constraints: args.constraints,
      rootPath: args.rootPath,  // optional: absolute path to target project root
    });
    const summary = getWorkspaceSummary(activeId);
    if (ctx && ctx._ledgerRunId) {
      const { linkRunToWorkspace } = require('../governor/project_workspace');
      let runMeta = {};
      try {
        const { getLedger } = require('../governor/run_ledger');
        const runData = getLedger().getRun(ctx._ledgerRunId);
        if (runData) {
          runMeta = {
            createdAt: runData.started_at,
            taskType: runData.task_type,
            activeAgentId: runData.agent_id,
            modelPreset: runData.model_preset,
            promptPreview: runData.prompt
          };
        }
      } catch (e) {}
      linkRunToWorkspace(normId, ctx._ledgerRunId, runMeta);
    }
    return {
      action: 'Created and activated workspace',
      projectId: normId,
      result: `Workspace "${normId}" created successfully and set as active.\n\nSummary:\n${JSON.stringify(summary, null, 2)}`
    };
  } catch (err) {
    return { error: `Failed to create workspace: ${err.message}` };
  }
}

async function handleWorkspaceList(args, ctx) {
  try {
    const { listWorkspaces } = require('../governor/project_workspace');
    const list = listWorkspaces();
    return {
      result: JSON.stringify(list, null, 2)
    };
  } catch (err) {
    return { error: `Failed to list workspaces: ${err.message}` };
  }
}

async function handleWorkspaceSetActive(args, ctx) {
  try {
    const { setActiveWorkspace, getWorkspaceSummary } = require('../governor/project_workspace');
    const normId = setActiveWorkspace(args.projectId);
    const summary = getWorkspaceSummary(normId);
    if (ctx && ctx._ledgerRunId) {
      const { linkRunToWorkspace } = require('../governor/project_workspace');
      let runMeta = {};
      try {
        const { getLedger } = require('../governor/run_ledger');
        const runData = getLedger().getRun(ctx._ledgerRunId);
        if (runData) {
          runMeta = {
            createdAt: runData.started_at,
            taskType: runData.task_type,
            activeAgentId: runData.agent_id,
            modelPreset: runData.model_preset,
            promptPreview: runData.prompt
          };
        }
      } catch (e) {}
      linkRunToWorkspace(normId, ctx._ledgerRunId, runMeta);
    }
    return {
      action: 'Set active workspace',
      projectId: normId,
      result: `Workspace "${normId}" is now active.\n\nSummary:\n${JSON.stringify(summary, null, 2)}`
    };
  } catch (err) {
    return { error: `Failed to set active workspace: ${err.message}` };
  }
}

async function handleWorkspaceStatus(args, ctx) {
  try {
    const { getActiveWorkspace, getWorkspaceSummary, diagnoseWorkspaceState } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      const diagnostics = diagnoseWorkspaceState();
      let message = 'No active project workspace is set. Call workspace_create or workspace_set_active first.';
      if (diagnostics.availableWorkspaceIds.length > 0) {
        message += `\n\nAvailable workspaces: ${diagnostics.availableWorkspaceIds.join(', ')}. Use workspace_set_active with one of these project IDs to restore state, or create a new workspace.`;
      }
      message += `\n\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
      return {
        result: message,
        diagnostics
      };
    }
    const summary = getWorkspaceSummary(activeId);
    return {
      result: JSON.stringify(summary, null, 2)
    };
  } catch (err) {
    return { error: `Failed to get workspace status: ${err.message}` };
  }
}

async function handleWorkspaceAddTask(args, ctx) {
  try {
    const { getActiveWorkspace, writeWorkspaceArtifact } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      return { error: 'No active workspace. Please set an active workspace first.' };
    }
    const safeTitle = args.title.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '');
    const filename = `${safeTitle || 'task'}.md`;
    const fullPath = writeWorkspaceArtifact(activeId, 'tasks', filename, args.content);
    return {
      action: 'Added task',
      path: filename,
      result: `Task added successfully to active workspace "${activeId}".\nSaved to tasks/${filename} (Absolute: ${fullPath})`
    };
  } catch (err) {
    return { error: `Failed to add task: ${err.message}` };
  }
}

async function handleWorkspaceAddPlan(args, ctx) {
  try {
    const { getActiveWorkspace, writeWorkspaceArtifact } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      return { error: 'No active workspace. Please set an active workspace first.' };
    }
    const safeTitle = args.title.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '');
    const filename = `${safeTitle || 'plan'}.md`;
    const fullPath = writeWorkspaceArtifact(activeId, 'plans', filename, args.content);
    return {
      action: 'Added plan',
      path: filename,
      result: `Plan added successfully to active workspace "${activeId}".\nSaved to plans/${filename} (Absolute: ${fullPath})`
    };
  } catch (err) {
    return { error: `Failed to add plan: ${err.message}` };
  }
}

async function handleWorkspaceAddArtifact(args, ctx) {
  try {
    const { getActiveWorkspace, writeWorkspaceArtifact } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      return { error: 'No active workspace. Please set an active workspace first.' };
    }
    if (args.name.includes('/') || args.name.includes('\\') || args.name.includes('..')) {
      return { error: 'Artifact name must not contain directory separators or traversal sequences.' };
    }
    const fullPath = writeWorkspaceArtifact(activeId, 'artifacts', args.name, args.content);
    return {
      action: 'Added artifact',
      path: args.name,
      result: `Artifact "${args.name}" added successfully to active workspace "${activeId}".\nSaved to artifacts/${args.name} (Absolute: ${fullPath})`
    };
  } catch (err) {
    return { error: `Failed to add artifact: ${err.message}` };
  }
}

async function handleWorkspaceLinkRun(args, ctx) {
  try {
    const { getActiveWorkspace, linkRunToWorkspace } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      return { error: 'No active workspace. Please set an active workspace first.' };
    }
    let runMeta = {};
    try {
      const { getLedger } = require('../governor/run_ledger');
      const runData = getLedger().getRun(args.runId);
      if (runData) {
        runMeta = {
          createdAt: runData.started_at,
          taskType: runData.task_type,
          activeAgentId: runData.agent_id,
          modelPreset: runData.model_preset,
          promptPreview: runData.prompt
        };
      }
    } catch (e) {}
    linkRunToWorkspace(activeId, args.runId, runMeta);
    return {
      action: 'Linked run',
      result: `Run "${args.runId}" linked successfully to active workspace "${activeId}".`
    };
  } catch (err) {
    return { error: `Failed to link run: ${err.message}` };
  }
}

async function handleWorkspaceSetRoot(args, ctx) {
  try {
    const { getActiveWorkspace, ensureWorkspace, getWorkspaceSummary, validateTargetRoot } = require('../governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (!activeId) {
      return { error: 'No active workspace. Please set an active workspace first.' };
    }
    
    let targetPath = args.rootPath;
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { error: 'rootPath must be a non-empty string.' };
    }
    
    if (targetPath.includes('..')) {
      return { error: `rootPath contains directory traversal sequence: "${targetPath}".` };
    }
    
    if (!path.isAbsolute(targetPath)) {
      return { error: `rootPath must be an absolute path. Got: "${targetPath}".` };
    }
    
    const resolvedPath = path.resolve(targetPath);
    
    const createIfMissing = !!args.createIfMissing;
    if (!fs.existsSync(resolvedPath)) {
      if (createIfMissing) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      } else {
        return { error: `rootPath does not exist on disk: "${resolvedPath}". Set createIfMissing to true to create it.` };
      }
    }
    
    validateTargetRoot(resolvedPath, { mustExist: true });
    
    ensureWorkspace(activeId, { rootPath: resolvedPath });
    
    const summary = getWorkspaceSummary(activeId);
    return {
      action: 'Set workspace root',
      projectId: activeId,
      rootPath: resolvedPath,
      result: `Workspace "${activeId}" target root path successfully updated to: ${resolvedPath}.\n\nWorkspace Summary:\n${JSON.stringify(summary, null, 2)}`
    };
  } catch (err) {
    return { error: `Failed to set workspace root: ${err.message}` };
  }
}

async function handleWorkspaceDiagnose(args, ctx) {
  try {
    const { diagnoseWorkspaceState } = require('../governor/project_workspace');
    const diagnostics = diagnoseWorkspaceState();
    return {
      result: JSON.stringify(diagnostics, null, 2)
    };
  } catch (err) {
    return { error: `Failed to run workspace diagnostics: ${err.message}` };
  }
}

module.exports = {
  handleWorkspaceCreate,
  handleWorkspaceList,
  handleWorkspaceSetActive,
  handleWorkspaceStatus,
  handleWorkspaceAddTask,
  handleWorkspaceAddPlan,
  handleWorkspaceAddArtifact,
  handleWorkspaceLinkRun,
  handleWorkspaceSetRoot,
  handleWorkspaceDiagnose
};
