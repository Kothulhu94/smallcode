// SmallCode — Tool Executor
// Executes tool calls from the model. Accepts a context object for shared state.
//
// Usage:
//   const { executeTool } = require('./executor');
//   const result = await executeTool(name, args, ctx);
//
// ctx: { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui }

const path = require('path');
const fs = require('fs');
const {
  escapeShellArg,
  buildCommand,
  safeResolvePath,
  sanitizeToolOutput,
  stripAnsi: secStripAnsi,
  normalizeRelativePathOrPattern,
  globSearchFallback,
} = require('../src/security/sanitize');
const { getShell } = require('../src/tools/shell_session');
const { getReadTracker } = require('../src/tools/read_tracker');
const { getSnapshotManager } = require('../src/session/snapshot');
const { getFileStateTracker } = require('../src/session/file_state');

const {
  resetTurnFallback,
  checkDuplicateToolCall,
  recordSuccessfulToolCall
} = require('../src/executor/suppression');

const {
  authorizeAgentTool,
  checkCodeEditorDrift,
  enforceConstrainedFileSet,
  checkWorkspaceRoot,
  checkDirectoryTraversal
} = require('../src/executor/authorization');

const { rtkRewrite } = require('../src/executor/rtk_rewrite');
const { handleListProjects, handleGraphSearch, handleExplainSymbol } = require('../src/executor/project_handlers');
const {
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
} = require('../src/executor/workspace_handlers');
const {
  handleReadFile,
  handleWriteFile,
  handleAppendFile,
  handlePatch,
  handleReadAndPatch,
  handleCreateAndRun,
  handleFindAndRead,
  handleSearchAndRead
} = require('../src/executor/file_handlers');
const { handleBash, handleRun } = require('../src/executor/run_handlers');

const {
  handleVisionScreenshot,
  handleVisionList,
  handleVisionDescribe,
  handleVisionAsk
} = require('../src/executor/vision_handlers');
const {
  handleMemoryLoad,
  handleMemoryRemember,
  handleMemoryList,
  handleMemoryForget
} = require('../src/executor/memory_handlers');
const { handleBoneCompile, handleBoneCheck } = require('../src/executor/bone_handlers');
const { handleWebSearch, handleWebFetch } = require('../src/executor/web_handlers');
const { handleConfigureProvider, handleProviderStatus } = require('../src/executor/provider_handlers');

function showMiniDiff(tui, filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

async function executeTool(name, args, ctx) {
  const { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui } = ctx || {};
  const { execSync } = require('child_process');
  const cwd = process.cwd();

  // Agent Registry Tool Permission Enforcement (Milestone 5)
  const authCheck = authorizeAgentTool(name, ctx);
  if (authCheck.error) {
    return { error: authCheck.error };
  }

  // Sanitize all string args — strip ANSI escape sequences the model may have
  // hallucinated into command strings (e.g. color codes in bash arguments).
  // Uses the comprehensive ANSI stripper from src/security/sanitize.js so
  // we cover OSC, DCS, 8-bit C1, and other escape forms too — not just CSI.
  function stripAnsi(str) { return secStripAnsi(str); }
  if (args && typeof args === 'object') {
    for (const key of Object.keys(args)) {
      if (typeof args[key] === 'string') args[key] = stripAnsi(args[key]);
    }
  }

  // Duplicate Tool Call Suppression
  const dupCheck = checkDuplicateToolCall(ctx, name, args);
  if (dupCheck.error) {
    return dupCheck; // returns { error: ... }
  }
  const callSet = dupCheck.callSet;
  const callHash = dupCheck.callHash;

  const toolStart = Date.now();
  let result;
  try {
    result = await _executeToolInner(name, args, ctx);
  } catch (e) {
    result = { error: e.message || String(e) };
  }

  if (!result.error) {
    recordSuccessfulToolCall(callSet, callHash);
  }

  // Record tool call in ledger
  if (ctx && ctx._ledgerRunId) {
    try {
      const { getLedger } = require('../src/governor/run_ledger');
      const durationMs = Date.now() - toolStart;
      const resultSummary = result.error
        ? `error: ${result.error}`
        : result.result
          ? String(result.result).slice(0, 500)
          : (result.action ? `${result.action} ${result.path || ''}` : 'success');

      getLedger().recordToolCall({
        runId: ctx._ledgerRunId,
        toolName: name,
        args: args,
        resultSummary,
        success: !result.error,
        durationMs,
      });
    } catch (e) {
      // Degrade silently
    }
  }

  return result;
}

async function _executeToolInner(name, args, ctx) {
  const { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui } = ctx || {};
  
  const { getActiveWorkspace, getActiveTargetRoot } = require('../src/governor/project_workspace');
  const activeWorkspaceId = getActiveWorkspace();
  let cwd = process.cwd();

  const writeTools = new Set(['write_file', 'append_file', 'patch', 'read_and_patch', 'create_and_run', 'bone_compile']);
  const readTools = new Set(['read_file', 'find_files', 'search', 'find_and_read', 'search_and_read', 'bone_check']);

  // Executor Defense-in-Depth for code_editor task drift
  const driftCheck = checkCodeEditorDrift(name, ctx);
  if (driftCheck.error) {
    return driftCheck;
  }

  // Constrained File Set Enforcement
  const fileSetCheck = enforceConstrainedFileSet(name, args, ctx, writeTools);
  if (fileSetCheck.error) {
    return fileSetCheck;
  }

  const rootCheck = checkWorkspaceRoot(name, activeWorkspaceId, getActiveTargetRoot, writeTools, readTools);
  if (rootCheck.error) {
    return rootCheck;
  }
  cwd = rootCheck.cwd;

  // Reject directory traversal patterns for file/pattern tools
  const travCheck = checkDirectoryTraversal(name, args);
  if (travCheck.error) {
    return travCheck;
  }

  switch (name) {
    case 'vision_screenshot': return await handleVisionScreenshot();
    case 'vision_list': return await handleVisionList();
    case 'vision_describe': return await handleVisionDescribe(args, config);
    case 'vision_ask': return await handleVisionAsk(args, config);

    case 'workspace_create': return await handleWorkspaceCreate(args, ctx);
    case 'workspace_list': return await handleWorkspaceList(args, ctx);
    case 'workspace_set_active': return await handleWorkspaceSetActive(args, ctx);
    case 'workspace_status': return await handleWorkspaceStatus(args, ctx);
    case 'workspace_add_task': return await handleWorkspaceAddTask(args, ctx);
    case 'workspace_add_plan': return await handleWorkspaceAddPlan(args, ctx);
    case 'workspace_add_artifact': return await handleWorkspaceAddArtifact(args, ctx);
    case 'workspace_link_run': return await handleWorkspaceLinkRun(args, ctx);
    case 'workspace_set_root': return await handleWorkspaceSetRoot(args, ctx);
    case 'workspace_diagnose': return await handleWorkspaceDiagnose(args, ctx);

    case 'read_file': return await handleReadFile(args, cwd);
    case 'write_file': return await handleWriteFile(args, cwd, _fullscreenRef);
    case 'append_file': return await handleAppendFile(args, cwd);
    case 'patch': return await handlePatch(args, cwd, _fullscreenRef, tui);
    case 'read_and_patch': return await handleReadAndPatch(args, cwd, tui);
    case 'create_and_run': return await handleCreateAndRun(args, cwd);
    case 'find_and_read': return await handleFindAndRead(args, cwd);
    case 'search_and_read': return await handleSearchAndRead(args, cwd);

    case 'bash': return await handleBash(args, cwd, flags, _fullscreenRef, config, tui);

    case 'search': {
      try {
        // Resolve and contain the search path; default to cwd. This blocks
        // attacks like {pattern: 'foo', path: '/etc'} that would let the
        // model exfiltrate sensitive files outside the project.
        const safePath = args.path
          ? safeResolvePath(args.path, cwd)
          : { ok: true, fullPath: '.' };
        if (!safePath.ok) return { error: `search rejected: ${safePath.reason}` };
        const cmd = buildCommand('rg', ['--line-number', '--max-count', '10', '-C', '1'], String(args.pattern || ''))
          + ' ' + escapeShellArg(safePath.fullPath || '.');
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: sanitizeToolOutput(output).slice(0, 3000) };
      } catch { return { result: 'No matches found.' }; }
    }

    case 'find_files': {
      try {
        const pattern = normalizeRelativePathOrPattern(args.pattern, cwd);
        // Smart listing (Feature #17): if no glob pattern, use scored file tree
        // instead of dumping everything. With a pattern, use rg as before.
        if (!pattern || pattern === '*' || pattern === '**' || pattern === '.') {
          const { formatSmartListing } = require('../src/tools/file_tree');
          const hint = args.hint || ''; // caller can pass a hint for keyword scoring
          const listing = formatSmartListing(cwd, hint, { max: 50 });
          return { result: listing };
        }
        let files = [];
        try {
          const cmd = 'rg --files --glob ' + escapeShellArg(String(pattern || ''))
            + ' --glob ' + escapeShellArg('!node_modules')
            + ' --glob ' + escapeShellArg('!.git');
          const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
          files = output.trim().split('\n').filter(Boolean).slice(0, 30);
        } catch {
          files = globSearchFallback(pattern, cwd).slice(0, 30);
        }
        return { result: files.length ? `Found ${files.length} files:\n${files.join('\n')}` : 'No files found.' };
      } catch { return { result: 'No files found.' }; }
    }

    case 'list_projects': {
      return await handleListProjects(mcpCall);
    }

    case 'graph_search': {
      return await handleGraphSearch(mcpCall, args, cwd);
    }

    case 'explain_symbol': {
      return await handleExplainSymbol(mcpCall, args, cwd);
    }

    case 'run': return await handleRun(args, cwd);

    case 'memory_load': return await handleMemoryLoad(args, memoryStore, ctx);
    case 'memory_remember': return await handleMemoryRemember(args, memoryStore);
    case 'memory_list': return await handleMemoryList(args, memoryStore);
    case 'memory_forget': return await handleMemoryForget(args, memoryStore);

    case 'bone_compile': return await handleBoneCompile(args, cwd);
    case 'bone_check': return await handleBoneCheck(args, cwd);

    case 'web_search': return await handleWebSearch(args);
    case 'web_fetch': return await handleWebFetch(args);

    case 'select_category': {
      const category = args.category || 'read';
      return { result: `Category: ${category}. Proceed with your tool call.`, category };
    }

    case 'contract_status':
    case 'contract_create':
    case 'contract_assert_pass':
    case 'contract_assert_fail':
    case 'contract_assert_skip': {
      try {
        const { executeContractTool } = require('../src/session/contract_tools');
        return await executeContractTool(name, args, { cwd });
      } catch (e) {
        return { error: `${name} failed: ${e.message}` };
      }
    }

    case 'configure_provider': return await handleConfigureProvider(args);
    case 'provider_status': return await handleProviderStatus();

    default: {
      if (mcpClient && mcpClient.isMCPTool(name)) {
        const mcpResult = await mcpClient.callTool(name, args);
        if (mcpResult.error) return { error: mcpResult.error };
        return { result: mcpResult.result || '(no output)' };
      }
      if (pluginLoader) {
        const pluginResult = await pluginLoader.executeTool(name, args);
        if (pluginResult !== null) {
          if (pluginResult.error) return { error: pluginResult.error };
          return { result: typeof pluginResult === 'string' ? pluginResult : JSON.stringify(pluginResult) };
        }
      }
      return { error: `Unknown tool: ${name}` };
    }
  }
}

module.exports = { executeTool, resetTurnFallback };
