const path = require('path');

function authorizeAgentTool(name, ctx) {
  if (ctx && (ctx.activeAgent || ctx.currentTaskType)) {
    try {
      const { authorizeToolForAgent, getActiveAgentContext } = require('../governor/agent_registry');
      const authResult = authorizeToolForAgent(name, ctx.activeAgent || ctx.currentTaskType);

      // Milestone 6A: Record authorization event in run ledger
      try {
        const { getLedger } = require('../governor/run_ledger');
        const agentCtx = ctx.activeAgent || (ctx.currentTaskType ? getActiveAgentContext(ctx.currentTaskType) : null);
        getLedger().recordAuthorization({
          runId: ctx._ledgerRunId || null,
          toolName: name,
          taskType: ctx.currentTaskType || (ctx.activeAgent ? (ctx.activeAgent.agentId || ctx.activeAgent.id) : null),
          agentId: agentCtx?.agentId || agentCtx?.id || null,
          mode: process.env.SMALLCODE_ENFORCEMENT_MODE || 'warn',
          authorized: authResult.authorized !== false,
          reason: authResult.reason || authResult.warning || null,
        });
      } catch (e) { /* ledger errors are contained */ }

      if (authResult.authorized === false) {
        return { error: authResult.reason };
      }
      if (authResult.warning) {
        console.warn(authResult.warning);
      }
    } catch (e) {
      // Contain enforcement errors
    }
  }
  return { ok: true };
}

function checkCodeEditorDrift(name, ctx) {
  if (ctx && ctx.activeAgent && (ctx.activeAgent.agentId === 'code_editor' || ctx.activeAgent.id === 'code_editor')) {
    if (name === 'workspace_add_task' || name === 'workspace_add_plan') {
      return { error: `Tool execution denied: code_editor must implement coding tasks with file tools, not workspace planning tools.` };
    }
  }
  return { ok: true };
}

function enforceConstrainedFileSet(name, args, ctx, writeTools) {
  if (writeTools.has(name) && args && args.path) {
    let userMessage = '';
    if (ctx && ctx._ledgerRunId) {
      try {
        const { getLedger } = require('../governor/run_ledger');
        const runData = getLedger().getRun(ctx._ledgerRunId);
        if (runData && runData.prompt) {
          userMessage = runData.prompt;
        }
      } catch (e) {}
    } else if (ctx && ctx.config && ctx.config.activeHandoffPrompt) {
       userMessage = ctx.config.activeHandoffPrompt;
    }

    if (userMessage) {
      const onlyMatch = userMessage.match(/\bonly\s+([a-zA-Z0-9\.\/\-_,\s]+(?:and\s+[a-zA-Z0-9\.\/\-_]+)?)/i);
      if (onlyMatch) {
         const allowedList = onlyMatch[1]
           .replace(/,/g, ' ')
           .replace(/\band\b/ig, ' ')
           .split(/\s+/)
           .filter(Boolean);
         
         const hasFiles = allowedList.some(item => item.includes('.'));
         if (hasFiles) {
           const requestedPath = args.path.replace(/\\/g, '/');
           const isAllowed = allowedList.some(allowed => {
               const cleanAllowed = allowed.replace(/\\/g, '/');
               return requestedPath === cleanAllowed || 
                      requestedPath.endsWith('/' + cleanAllowed) || 
                      cleanAllowed === path.basename(requestedPath);
           });
           if (!isAllowed) {
               return { error: `Constrained request: you are only allowed to modify ${allowedList.join(', ')}. Blocked creation/modification of ${args.path}.` };
           }
         }
      }
    }
  }
  return { ok: true };
}

function checkWorkspaceRoot(name, activeWorkspaceId, getActiveTargetRoot, writeTools, readTools) {
  if (activeWorkspaceId) {
    const targetRoot = getActiveTargetRoot();
    if (targetRoot.ok) {
      return { ok: true, cwd: targetRoot.rootPath };
    } else {
      if (writeTools.has(name)) {
        return { error: 'Active workspace has no target project root set. Set rootPath before writing project files.' };
      }
      if (readTools.has(name)) {
        return { error: 'Active workspace has no target project root set. Set rootPath before reading project files.' };
      }
    }
  }
  return { ok: true, cwd: process.cwd() };
}

function checkDirectoryTraversal(name, args) {
  if (args && typeof args === 'object') {
    for (const key of ['path', 'pattern']) {
      if (typeof args[key] === 'string' && (args[key].includes('..') || args[key].includes('..\\') || args[key].includes('../'))) {
        return { error: `${name} rejected: ${key} contains directory traversal sequence: "${args[key]}"` };
      }
    }
  }
  return { ok: true };
}

module.exports = {
  authorizeAgentTool,
  checkCodeEditorDrift,
  enforceConstrainedFileSet,
  checkWorkspaceRoot,
  checkDirectoryTraversal
};
