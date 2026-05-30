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
    case 'vision_screenshot': {
      try {
        const { saveScreenshot } = require('../src/vision/image_artifact_store');
        const metadata = saveScreenshot();
        return {
          action: 'Captured',
          imageId: metadata.imageId,
          filePath: metadata.filePath,
          width: metadata.width,
          height: metadata.height,
          byteSize: metadata.byteSize,
          result: `Screenshot captured: ${metadata.filePath} (${metadata.width}x${metadata.height})`
        };
      } catch (err) {
        return { error: `Failed to capture screenshot: ${err.message}` };
      }
    }

    case 'vision_list': {
      try {
        const { listImages } = require('../src/vision/image_artifact_store');
        const images = listImages();
        return {
          result: JSON.stringify(images, null, 2)
        };
      } catch (err) {
        return { error: `Failed to list screenshots: ${err.message}` };
      }
    }

    case 'vision_describe': {
      try {
        const { saveScreenshot } = require('../src/vision/image_artifact_store');
        const { queryVisionModel } = require('../src/vision/vision_payload_builder');
        
        let imagePath = args.image_path;
        if (!imagePath) {
          const metadata = saveScreenshot();
          imagePath = metadata.filePath;
        }

        const queryResult = await queryVisionModel({
          text: "Describe this image in detail.",
          imagePath,
          config
        });

        if (queryResult.error) {
          return {
            error: queryResult.error,
            imagePath,
            hint: queryResult.hint
          };
        }

        return {
          result: queryResult.text,
          imagePath
        };
      } catch (err) {
        return { error: `Vision describe failed: ${err.message}` };
      }
    }

    case 'vision_ask': {
      try {
        const { saveScreenshot } = require('../src/vision/image_artifact_store');
        const { queryVisionModel } = require('../src/vision/vision_payload_builder');
        
        let imagePath = args.image_path;
        if (!imagePath) {
          const metadata = saveScreenshot();
          imagePath = metadata.filePath;
        }

        const queryResult = await queryVisionModel({
          text: args.question,
          imagePath,
          config
        });

        if (queryResult.error) {
          return {
            error: queryResult.error,
            imagePath,
            hint: queryResult.hint
          };
        }

        return {
          result: queryResult.text,
          imagePath
        };
      } catch (err) {
        return { error: `Vision ask failed: ${err.message}` };
      }
    }

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
        // Smart listing (Feature #17): if no glob pattern, use scored file tree
        // instead of dumping everything. With a pattern, use rg as before.
        if (!args.pattern || args.pattern === '*' || args.pattern === '**') {
          const { formatSmartListing } = require('../src/tools/file_tree');
          const hint = args.hint || ''; // caller can pass a hint for keyword scoring
          const listing = formatSmartListing(cwd, hint, { max: 50 });
          return { result: listing };
        }
        const cmd = 'rg --files --glob ' + escapeShellArg(String(args.pattern || ''))
          + ' --glob ' + escapeShellArg('!node_modules')
          + ' --glob ' + escapeShellArg('!.git');
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
        const files = output.trim().split('\n').filter(Boolean).slice(0, 30);
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

    case 'memory_load':
    case 'memory_remember':
    case 'memory_list':
    case 'memory_forget': {
      if (name === 'memory_load') {
        const task = args.task || '';
        const maxTokens = args.max_tokens || 2000;
        // Handle both budget-aware-mcp format ({objects, tokens_used}) and
        // fallback MemoryStore format (plain array).
        const raw = memoryStore.loadForTask(task, maxTokens, { taskType: ctx.currentTaskType, runId: ctx._ledgerRunId });
        const objects = Array.isArray(raw) ? raw : (raw?.objects || []);
        const tokens_used = Array.isArray(raw) ? objects.length * 50 : (raw?.tokens_used || 0);
        if (objects.length === 0) return { result: 'No relevant memory found.' };
        const formatted = objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n');
        return { result: `Loaded ${objects.length} memories (${tokens_used} tokens):\n\n${formatted}` };
      }
      if (name === 'memory_remember') {
        // Support both the budget-aware-mcp API (object arg) and fallback (positional).
        let obj;
        if (typeof memoryStore.remember === 'function' && memoryStore.remember.length >= 3) {
          // Fallback MemoryStore: remember(type, title, content, opts)
          obj = memoryStore.remember(args.type || 'context', args.title || '', args.content || '', { tags: args.tags || [] });
        } else {
          // budget-aware-mcp: remember({ type, title, content, tags, ... })
          obj = memoryStore.remember({ type: args.type || 'context', title: args.title || '', content: args.content || '', tags: args.tags || [], symbols: args.symbols || [], files: args.files || [] });
        }
        if (obj.duplicate) return { result: `Already known (confirmed existing: ${obj.existing_id})` };
        if (obj.rejected) return { result: `Rejected: ${obj.reason}` };
        return { result: `Remembered [${obj.type}] "${obj.title}" (${obj.id})` };
      }
      if (name === 'memory_list') {
        const objects = args.type ? memoryStore.byType(args.type) : memoryStore.all();
        if (objects.length === 0) return { result: 'No memory stored.' };
        return { result: objects.map(o => `[${o.id}] (${o.type}) ${o.title}`).join('\n') };
      }
      if (name === 'memory_forget') {
        const ok = memoryStore.forget(args.id);
        return { result: ok ? `Deleted ${args.id}` : `Not found: ${args.id}` };
      }
      return { result: '' };
    }

    case 'bone_compile': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `bone_compile rejected: ${safe.reason}` };
      const bonePath = safe.fullPath;
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      // Restrict the target string to a known whitelist — it gets passed
      // straight to the compiler CLI, so an unrestricted value is a
      // potential injection vector.
      const allowedTargets = new Set(['express', 'nakama', 'prisma', 'sqlite']);
      const target = String(args.target || 'express');
      if (!allowedTargets.has(target)) {
        return { error: `bone_compile: invalid target. Allowed: ${[...allowedTargets].join(', ')}` };
      }
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const cmd = 'node ' + escapeShellArg(compiler) + ' compile ' + escapeShellArg(bonePath) + ' --target ' + escapeShellArg(target);
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd });
        return { result: `Compiled ${args.path} → output/\n${sanitizeToolOutput(output).slice(0, 2000)}`, action: 'Created', path: 'output/' };
      } catch (e) {
        return { error: `BoneScript compile failed:\n${sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'bone_check': {
      const safe = safeResolvePath(args.path, cwd);
      if (!safe.ok) return { error: `bone_check rejected: ${safe.reason}` };
      const bonePath = safe.fullPath;
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const cmd = 'node ' + escapeShellArg(compiler) + ' check ' + escapeShellArg(bonePath);
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd });
        return { result: sanitizeToolOutput(output).trim() || '✓ No errors found.' };
      } catch (e) {
        return { error: `BoneScript validation errors:\n${sanitizeToolOutput((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'web_search': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webSearch } = require('../src/tools/builtin/web_browse');
      const results = await webSearch(args.query, 5);
      return { result: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'No results found.' };
    }

    case 'web_fetch': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webFetch } = require('../src/tools/builtin/web_browse');
      const content = await webFetch(args.url, 5000);
      return { result: content || 'Failed to fetch URL.' };
    }

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

    case 'configure_provider': {
      const { runWizard } = require('./provider-wizard/wizard');
      const hasAnyParam = args.provider || args.baseUrl || args.model || args.apiKey;
      let result;
      if (!hasAnyParam) {
        result = await runWizard({ interactive: true });
      } else {
        result = await runWizard({
          interactive: false,
          provider: args.provider,
          baseUrl: args.baseUrl,
          model: args.model,
          apiKey: args.apiKey,
          escalationProvider: args.escalationProvider,
          escalationModel: args.escalationModel,
        });
      }
      if (result.success) {
        return { result: `Provider configured: ${result.provider} (${result.baseUrl}) model=${result.model}${result.escalation ? ` escalation=${result.escalation}` : ''}. Restart SmallCode to apply.` };
      }
      return { error: result.error };
    }

    case 'provider_status': {
      const { getStatus, formatStatus } = require('./provider-wizard/status');
      return { result: formatStatus(getStatus()) };
    }

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
