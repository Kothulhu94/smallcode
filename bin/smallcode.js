#!/usr/bin/env node
// SmallCode — AI coding agent for small LLMs
// Entry point: parses args, boots the TUI or runs in non-interactive mode
//
// This is the bootstrap that loads until the Marrowscript runtime is ready.
// It provides the same interface the compiled .marrow output would.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env file (checks multiple locations, first found wins)
(function loadDotenv() {
  const os = require('os');
  const envPaths = [
    path.join(process.cwd(), '.env'),                          // project root
    path.join(process.cwd(), '.smallcode', '.env'),            // .smallcode dir
    path.join(os.homedir(), '.config', 'smallcode', '.env'),   // global config
    path.join(os.homedir(), '.smallcode', '.env'),             // global alt
  ];

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Don't override existing env vars
        if (!process.env[key]) process.env[key] = value;
      }
      // Don't break — load all env files so global config is always available.
      // Project .env values take priority since they're loaded first (line 38 won't overwrite).
    } catch {}
  }
})();
const readline = require('readline');
const os = require('os');
const tui = require('./tui');
const chalk = tui.chalk;
const {
  loadConfig: loadConfigModule,
  checkEndpoint,
  buildAuthHeaders,
  getModelTarget,
  getModelTargetForModel,
  withModelTarget,
} = require('./config');
const { TOOLS, COMPOUND_TOOLS, PROVIDER_TOOLS, getAllTools: _getAllToolsModule } = require('./tools');
const { runValidation: _runValidationModule } = require('./model_client');
const { mcpCall, initCodeGraph, killMCP, getMcpProcess } = require('./mcp_bridge');
const { executeTool: _executeToolModule } = require('./executor');
let McpMemoryStore;
try {
  McpMemoryStore = require('budget-aware-mcp/dist/memory/store.js').MemoryStore;
} catch {
  McpMemoryStore = null;
}
const { ToolScorer, checkAndEnforceHardFail, classifyTask, classifyTaskAsync } = require('./governor');
const { EscalationEngine } = require('./escalation');
const { EarlyStopDetector } = require('../src/governor/early_stop');
const { QualityMonitor } = require('../src/governor/quality_monitor');
const { applyReadGuard } = require('../src/session/read_guard');
const { TokenMonitor } = require('./token_monitor');
const { TraceRecorder } = require('./trace_recorder');
const { EvalRunner } = require('./eval_runner');
const {
  repairToolCall,
  summarizeFileCompiled,
  assertWithinBudget,
  chargeBudget,
  getBudgetState,
  setApprovalHandler,
  awaitCheckpointDecision,
  submitCheckpointDecision,
  retrieveContext,
  validateEditCompiled,
} = (() => { try { return require('./features_adapter'); } catch { return {}; } })();
const { getProfile } = require('../src/model/profiles');
const { MCPClient } = require('../src/tools/mcp_client');
const { PluginLoader } = require('../src/plugins/loader');
const { SkillManager } = require('../src/plugins/skills');
const { SessionStore } = require('../src/session/persistence');
const { resolveReferences, formatReferencesForPrompt } = require('../src/session/references');
const { TokenTracker } = require('../src/session/tokens');
const { UndoStack } = require('../src/session/undo');
const { shouldInjectGitContext, getGitDiffContext } = require('../src/session/git_context');
const { routeTier } = require('../src/model/router');
const { openJournal, EVENT_TYPES } = require('../src/session/event_journal');

// Initialize structured memory (budget-aware-mcp's SQLite + FTS5 store, falls back to JSON)
let memoryStore;
try {
  if (McpMemoryStore) {
    memoryStore = new McpMemoryStore(process.cwd());
  } else {
    throw new Error('budget-aware-mcp not available');
  }
} catch {
  const { MemoryStore } = require('./memory');
  memoryStore = new MemoryStore(process.cwd());
}

// Initialize governor (tool scoring + verification)
const toolScorer = new ToolScorer();
const earlyStop = new EarlyStopDetector();
const qualityMonitor = new QualityMonitor();
const tokenMonitor = new TokenMonitor();
const traceRecorder = new TraceRecorder(process.cwd());
let currentToolCategory = null; // Set per-turn by compiled tool router
let currentTaskType = 'coding';
let currentAgentContext = null;
let config = null; // Set in main(), used by executeTool and chatCompletion
let currentLedgerRunId = null;
let currentLedgerPromptTokens = 0;
let currentLedgerCompletionTokens = 0;

// Initialize escalation engine (lazy — resolves config at boot)
let escalationEngine = null; // created after config loads

// Initialize plugin + skill systems
let pluginLoader = null;
let skillManager = null;

// Session persistence + token tracking
let sessionStore = null;
let tokenTracker = null;
let journal = null;

function logEvent(type, payload, tags) {
  if (journal) {
    try {
      journal.append(type, payload, tags);
    } catch (e) {
      // Safe guard to prevent logging failure from affecting execution
    }
  }
}

// Fullscreen TUI reference for streaming (set when fullscreen mode is active)
let _fullscreenRef = null;

const { parseArgs, handleQuickExits, VERSION } = require('../src/cli/args_parser');
const { flags, positional } = parseArgs(process.argv.slice(2));
handleQuickExits(flags);

// ─── Config ──────────────────────────────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return loadConfigModule(flags);
}

// ─── Endpoint Check (delegated to config module) ─────────────────────────────

async function checkOllama(config) {
  return checkEndpoint(config);
}

// ─── TUI ─────────────────────────────────────────────────────────────────────

// Conversation history for multi-turn
const conversationHistory = [];

// Plan tracker — Feature 8 plan-then-execute. Lazy-instantiated per agent run.
let _planTracker = null;
// Per-run detectors (Features 4, 10-11): re-built each runAgentLoop call
// bound to process.cwd() so bench tasks in temp dirs get correct context.
let _bootstrapDetector = null;
let _testRunnerDetector = null;
let _knowledgeLoader = null;
const improvementAttempts = {}; // filePath → attempt count

// runTUI is extracted to src/runtime/tui_manager.js

// ─── Model Communication ─────────────────────────────────────────────────────

// Tool definitions imported from bin/tools.js (TOOLS, COMPOUND_TOOLS, getAllTools)

const _toolExecution = require('../src/runtime/tool_execution');

// Execute a tool call — delegates to executor.js module.
// Wrapped with dedup (Feature 6): identical pure-tool calls within the recent
// window are short-circuited with a cached result. Disable with SMALLCODE_DEDUP=false.
async function executeTool(name, args) {
  return _toolExecution.executeTool(name, args, {
    _fullscreenRef: typeof _fullscreenRef !== 'undefined' ? _fullscreenRef : undefined,
    mcpCall,
    memoryStore,
    pluginLoader,
    mcpClient: typeof mcpClient !== 'undefined' ? mcpClient : null,
    flags,
    config,
    tui,
    currentTaskType,
    currentLedgerRunId,
    currentAgentContext
  });
}

// ─── COMPOUND TOOLS ──────────────────────────────────────────────────────────
// Tool definitions + routing loaded from bin/tools.js
// getAllTools delegates to the module with plugin/mcp context.
// Trust decay (Feature 13): dropped tools filtered from schema list.
// Feature 2: Query routing — filter write tools for read-only plan steps.
// Agent filtering: final pass intersects with currentAgentContext.allowedTools.
function getAllTools(config, stage2Category, options = {}) {
  return _toolExecution.getAllTools(config, stage2Category, {
    pluginLoader,
    mcpClient: typeof mcpClient !== 'undefined' ? mcpClient : null,
    taskType: options.taskType || currentTaskType,
    agentContext: options.agentContext || currentAgentContext,
    planTracker: typeof _planTracker !== 'undefined' ? _planTracker : null,
    ...options
  });
}

function buildChatRequestBody(messages, tools, config, options = {}) {
  return _toolExecution.buildChatRequestBody(messages, tools, config, {
    fullscreenRef: typeof _fullscreenRef !== 'undefined' ? _fullscreenRef : undefined,
    ...options
  });
}
let ALL_TOOLS = [...TOOLS, ...COMPOUND_TOOLS, ...PROVIDER_TOOLS];

const MAX_TOOL_CALLS = 500;
const MAX_IMPROVE_ITERATIONS = 2;

function estimateMessageTokens(m) {
  return _toolExecution.estimateMessageTokens(m);
}

function estimateHistoryTokens(history) {
  return _toolExecution.estimateHistoryTokens(history);
}

async function runAgentLoop(userMessage, config) {
  let runStatus = 'completed';
  try {
    await _runAgentLoopInner(userMessage, config);
  } catch (err) {
    runStatus = 'error';
    throw err;
  } finally {
    if (currentLedgerRunId) {
      try {
        const { getLedger } = require('../src/governor/run_ledger');
        getLedger().endRun(currentLedgerRunId, {
          status: runStatus,
          promptTokens: currentLedgerPromptTokens,
          completionTokens: currentLedgerCompletionTokens
        });
      } catch (e) {}
      currentLedgerRunId = null;
    }
  }
}

async function _runAgentLoopInner(userMessage, config) {
  // Reset early-stop state for new turn
  earlyStop.newTurn();
  // Reset quality monitor's consecutive-correction window for the new turn.
  qualityMonitor.reset();
  try { require('./executor').resetTurnFallback(); } catch {}

  if (config) {
    delete config.activeEscalationSummary;
    delete config.activeHandoffPrompt;
    delete config.activeHandoffPacket;
  }

  const { createFailureState, updateFailureState, classifyFailureEvent } = require('../src/governor/escalation_policy');
  const failureState = createFailureState();
  let terminalFailureReached = false;

  const triggerAgentEscalation = (reasonType, detail = {}) => {
    try {
      const { shouldEscalate, resolveEscalationTarget, buildEscalationSummary } = require('../src/governor/escalation_policy');
      const escCheck = shouldEscalate(failureState, currentAgentContext, { maxToolCalls: MAX_TOOL_CALLS, userMessage });
      if (!escCheck.escalate) return false;

      if (escCheck.terminal) {
        console.log(chalk.red(`\n  ✗ Terminal failure: ${escCheck.reason} — ${escCheck.summary}`));
        terminalFailureReached = true;
        return 'terminal';
      }

      const prevAgentId = currentAgentContext.agentId;
      const prevAgentName = currentAgentContext.name;
      const prevPreset = currentAgentContext.modelPreset;

      const targetResolve = resolveEscalationTarget(currentAgentContext, escCheck.reason, {
        toolName: detail.toolName,
        pastEscalations: failureState.pastEscalations
      });

      if (targetResolve.terminal) {
        console.log(chalk.red(`\n  ✗ Terminal escalation: ${targetResolve.reason}`));
        terminalFailureReached = true;
        return 'terminal';
      }

      const { getActiveAgentContext } = require('../src/governor/agent_registry');
      const targetAgent = getActiveAgentContext(targetResolve.target) || getActiveAgentContext('multi_step');

      currentAgentContext = targetAgent;
      failureState.pastEscalations.push({
        from: prevAgentId,
        to: targetAgent.agentId,
        reason: escCheck.reason
      });

      // Re-resolve model target preset
      if (config.models && currentAgentContext && currentAgentContext.modelPreset) {
        const { resolveModelTargetForAgent } = require('../src/model/router');
        const newTarget = resolveModelTargetForAgent(currentAgentContext, config);
        if (newTarget) {
          config.activeModelTarget = newTarget;
        }
      }

      // Query ledger details for handoff if available
      let toolEvents = null;
      let memoryEvents = null;
      if (currentLedgerRunId) {
        try {
          const { getLedger } = require('../src/governor/run_ledger');
          const ledger = getLedger();
          toolEvents = ledger.getToolCalls(currentLedgerRunId);
          memoryEvents = ledger.getMemoryContextEvents(currentLedgerRunId);
        } catch (e) {}
      }

      // Create handoff packet
      const { createHandoffPacket, renderHandoffForPrompt } = require('../src/governor/handoff_packet');
      const handoffPacket = createHandoffPacket({
        runId: currentLedgerRunId,
        fromAgentId: prevAgentId,
        toAgentId: targetAgent.agentId,
        taskType: currentTaskType,
        reason: escCheck.reason,
        summary: escCheck.summary,
        userMessage,
        failureState,
        editedFiles: _editedFilesThisTurn,
        modelPresetBefore: prevPreset,
        modelPresetAfter: targetAgent.modelPreset,
        toolEvents,
        memoryEvents
      });

      config.activeHandoffPacket = handoffPacket;
      config.activeHandoffPrompt = renderHandoffForPrompt(handoffPacket);

      // Link handoff packet to active workspace
      try {
        const { getActiveWorkspace, linkHandoffToWorkspace } = require('../src/governor/project_workspace');
        const activeId = getActiveWorkspace();
        if (activeId) {
          linkHandoffToWorkspace(activeId, handoffPacket);
        }
      } catch (wsErr) {
        // Workspace failure must not crash the harness
      }

      // Record in run ledger
      if (currentLedgerRunId) {
        const { getLedger } = require('../src/governor/run_ledger');
        const ledger = getLedger();
        
        ledger.recordStep({
          runId: currentLedgerRunId,
          stepIndex: loopStepIndex++,
          stepType: 'agent_escalation',
          name: `${prevAgentId} -> ${targetAgent.agentId}`,
          durationMs: 0,
          success: true,
          summary: `Escalated from ${prevAgentName} to ${targetAgent.name}. Reason: ${escCheck.reason}. Summary: ${escCheck.summary}`
        });

        ledger.recordStep({
          runId: currentLedgerRunId,
          stepIndex: loopStepIndex++,
          stepType: 'agent_handoff',
          name: `${prevAgentId} -> ${targetAgent.agentId}`,
          durationMs: 0,
          success: true,
          summary: config.activeHandoffPrompt
        });
      }

      // Build escalation note
      config.activeEscalationSummary = buildEscalationSummary(failureState, {
        reason: escCheck.reason,
        target: targetAgent.agentId,
        from: prevAgentId,
        summary: escCheck.summary
      });

      conversationHistory.push({ role: 'system', content: config.activeEscalationSummary });
      conversationHistory.push({ role: 'system', content: config.activeHandoffPrompt });

      console.log(chalk.magenta(`\n  ⬆ [ESCALATING AGENT] ${prevAgentName} → ${currentAgentContext.name} (${escCheck.reason})`));
      if (_fullscreenRef) {
        _fullscreenRef.addTool('escalate', 'warn', `${prevAgentId} → ${targetAgent.agentId}`);
      }

      return true;
    } catch (err) {
      return false;
    }
  };

  // Reset per-turn idempotent-write dedup. PURE_TOOLS dedup uses a sliding
  // window across turns; this set is *per-turn* and stops `memory_remember`
  // (and friends) from being called with identical args repeatedly in a
  // single turn. See src/tools/dedup.js for the full rationale.
  try {
    const { newTurnIdempotentWriteSet } = require('../src/tools/dedup');
    newTurnIdempotentWriteSet();
  } catch {}

  // Start trace recording for this turn
  traceRecorder.start(userMessage, config.model.name);

  // Mark new turn in token monitor (next recordCall will start a new turn entry)
  tokenMonitor._nextCallIsNewTurn = true;

  // Feature 3: rate limiting — assert within budget before starting turn
  try {
    if (assertWithinBudget) assertWithinBudget('run_turn', {});
  } catch (e) {
    const msg = e.message || String(e);
    if (_fullscreenRef) _fullscreenRef.addTool('policy', 'err', msg);
    else console.log(`  \x1b[33m⚠ ${msg}\x1b[0m`);
    // Still proceed — rate limiting is advisory for local use
  }

  // Clarification loop — detect vague prompts before wasting tool calls.
  // MarrowScript Feature #1: uses compiled intent_clarifier (LLM-based, cached 30m)
  // with automatic fallback to regex when the model is unavailable.
  // Only fires on short messages (< 80 chars) — long messages are almost never vague
  // and we don't want to add 2s latency to every detailed task description.
  const { getClarificationInstruction } = require('../src/session/clarify');
  let _needsClarification = false;
  // Skip clarifier when the message is clearly actionable even if short:
  // - Looks like a file path (quoted, contains slash/backslash, has extension)
  // - Pure number or "option N" / "work on N" — context-reference to prior options
  // - Affirmation in continuation context (yes/ok/sure/proceed)
  // - ROOT CAUSE FIX: assistant's last turn ended with a question — user reply is an answer,
  //   not a new task. Evaluate messages in context, not in isolation.
  const lastAssistantMsg = [...conversationHistory].reverse().find(m => m.role === 'assistant');
  const assistantAskedQuestion = typeof lastAssistantMsg?.content === 'string' && lastAssistantMsg.content.trimEnd().endsWith('?');
  const looksLikePath = /[\\\/]|\.\w{1,5}\s*$|^["'].*["']$/.test(userMessage.trim());
  const looksLikeOptionRef = /^(option\s+\d|work\s+on\s+\d|do\s+\d|start\s+with\s+\d|^\d+\.?\s*$|first|second|third|fourth)\b/i.test(userMessage.trim());
  // Multi-number selection (e.g. "1 and 2", "1, 2", "both 1 and 2")
  const looksLikeMultiSelect = /^(both\s+)?\d+(\s*,\s*|\s+and\s+)\d+$/i.test(userMessage.trim());
  const looksLikeAffirmation = (
    /^(yes|y|yep|yeah|sure|ok|okay|go|proceed|do it|continue|please|alright|👍|✅)\b\s*\.?\s*$/i.test(userMessage.trim()) ||
    // Multi-word continuations: "go ahead", "go ahead and read it", "read it", "do that", "that one"
    /^(go ahead|go for it|just do it|do that|do both|read it|show me|that one|sounds good|let's do it|let's go|that works)\b/i.test(userMessage.trim())
  );
  if (userMessage.length < 80 && !assistantAskedQuestion && !looksLikePath && !looksLikeOptionRef && !looksLikeMultiSelect && !looksLikeAffirmation) {
    try {
      const { checkNeedsClarification } = require('./features_adapter');
      _needsClarification = await checkNeedsClarification(userMessage);
    } catch {
      const { needsClarification } = require('../src/session/clarify');
      _needsClarification = needsClarification(userMessage);
    }
  }
  if (_needsClarification) {
    // Inject clarification instruction into this turn only — record the index
    // so we can splice it out after the model responds, otherwise it persists
    // in history and re-fires on every subsequent turn.
    conversationHistory.push({ role: 'user', content: userMessage });
    const _clarifierIdx = conversationHistory.length;
    conversationHistory.push({ role: 'system', content: getClarificationInstruction() });
    const response = await chatCompletion(config, conversationHistory);
    // Always remove the one-shot clarifier instruction whether the model responded or not
    if (_clarifierIdx >= 0 && _clarifierIdx < conversationHistory.length) {
      const msg = conversationHistory[_clarifierIdx];
      if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
          msg.content.includes('vague')) {
        conversationHistory.splice(_clarifierIdx, 1);
      }
    }
    const message = response?.choices?.[0]?.message;
    if (message?.content) {
      conversationHistory.push({ role: 'assistant', content: message.content });
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    }

    // One-question policy: model asked its question AND started working.
    // If the model already issued tool calls in its clarification response,
    // fall through to the main agent loop below to continue executing.
    // If it only asked a question (no tool calls), fall through anyway —
    // the model will continue on its best interpretation next turn.
    // Do NOT return here — the dev loop must continue.
    if (message?.tool_calls?.length > 0) {
      // Model already started working — the main loop below will pick up
      // the tool calls from this response. Reconstruct userMessage for the
      // main loop by using what's already in conversationHistory.
      // Fall through to main agent loop.
    } else {
      // Model asked its question but didn't start working yet.
      // In interactive mode, show the question and wait for the next user turn.
      // The clarifier will NOT re-fire next turn (assistantAskedQuestion guard).
      return;
    }
  }

  // Detect drag-and-dropped image files (bare path pasted into terminal)
  const { detectDroppedFile } = require('../src/session/images');
  const droppedPath = detectDroppedFile(userMessage);
  if (droppedPath) {
    // Convert bare path into an @reference prompt
    userMessage = `@${droppedPath} — I dropped this image. What would you like me to do with it?`;
    if (_fullscreenRef) _fullscreenRef.addTool('image', 'ok', `attached: ${path.basename(droppedPath)}`);
  }

  // Resolve @file references in user input
  const { text, files } = resolveReferences(userMessage, process.cwd());
  let augmented = files.length > 0
    ? text + formatReferencesForPrompt(files)
    : text;

  // Auto-inject git diff when message implies recent changes
  if (shouldInjectGitContext(userMessage)) {
    const gitCtx = getGitDiffContext(process.cwd(), 80);
    if (gitCtx) augmented += gitCtx;
  }

  conversationHistory.push({ role: 'user', content: augmented });

  // Open a snapshot checkpoint for this agent run (Feature 9). All
  // write_file/patch calls during this run will record their pre-edit
  // state. On clean completion we commit (discard); on hard failure with
  // SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true we revert all writes.
  try {
    const { getSnapshotManager } = require('../src/session/snapshot');
    const snap = getSnapshotManager({ workdir: process.cwd() });
    snap.begin(`turn-${Date.now()}`);
  } catch {}

  // Plan-then-execute (Feature 8): for multi-step tasks, ask the model for
  // a numbered plan FIRST, then re-inject it as an anchor on subsequent
  // turns so it doesn't drift. Heuristic-based — single-shot tasks like
  // "create hello.py" don't trigger planning.
  let _planInstructionIdx = -1; // track the one-shot instruction so we can remove it
  try {
    const { shouldPlan, PlanTracker } = require('../src/session/plan_tracker');
    if (!_planTracker) _planTracker = new PlanTracker();
    _planTracker.reset();
    if (shouldPlan(userMessage)) {
      _planTracker.activate();
      // Append a one-shot instruction asking the model to emit a plan first.
      // We record the index so we can splice it out after the first response
      // — it must not persist in history and be re-sent on every subsequent call.
      _planInstructionIdx = conversationHistory.length;
      conversationHistory.push({
        role: 'system',
        content: PlanTracker.planRequestInstruction(),
      });
    }
  } catch {} // never fail the agent loop on planner errors

  // Initialise per-run detectors (Features 10-11) bound to THIS workdir.
  // Re-created each run so bench tasks running in temp dirs get correct info.
  try {
    const { BootstrapDetector } = require('../src/session/bootstrap');
    _bootstrapDetector = new BootstrapDetector({ workdir: process.cwd() });
  } catch { _bootstrapDetector = null; }
  try {
    const { TestRunnerDetector } = require('../src/tools/test_runner');
    _testRunnerDetector = new TestRunnerDetector({ workdir: process.cwd() });
  } catch { _testRunnerDetector = null; }
  // Knowledge loader (Feature 4) also per-run so bench tasks get their own workdir.
  try {
    const { KnowledgeLoader } = require('../src/knowledge/loader');
    _knowledgeLoader = new KnowledgeLoader({ rootDir: process.cwd() });
  } catch { _knowledgeLoader = null; }
  // Trust decay (Feature 13) resets per agent loop turn so TUI sessions
  // don't accumulate decay from unrelated prior requests.
  try {
    const { getTrustDecay } = require('../src/tools/trust_decay');
    getTrustDecay().reset();
  } catch {}

  // Multi-model chaining (Feature #15): async call to planner model to pre-
  // generate a numbered plan. Runs concurrently with task classification since
  // both are pure network calls — we await it just before the first chatCompletion.
  // Only fires when SMALLCODE_CHAIN=true, a planner model is configured, and the
  // task looks complex enough to benefit from pre-planning (fast tasks skip it).
  let _plannerPromise = null;
  try {
    const { callPlanner, getChainConfig } = require('../src/model/chain');
    const { estimateComplexity } = require('../src/model/router');
    const cc = getChainConfig();
    if (cc.enabled && cc.planner && estimateComplexity(userMessage) !== 'fast') {
      _plannerPromise = callPlanner(userMessage, config);
    }
  } catch {}

  // Governor: classify task type (determines verification strategy)
  // Uses MarrowScript-compiled classifier with regex fallback
  try {
    currentTaskType = await classifyTaskAsync(userMessage);
  } catch {
    currentTaskType = classifyTask(userMessage);
  }

  const { getActiveAgentContext } = require('../src/governor/agent_registry');
  currentAgentContext = getActiveAgentContext(currentTaskType) || getActiveAgentContext('multi_step');

  // Milestone 9: Model Preset Routing
  // Resolve model target from active agent preset first if config.models is configured
  let selectedTarget = null;
  let selectedTier = null;

  if (config.models && currentAgentContext && currentAgentContext.modelPreset) {
    try {
      const { resolveModelTargetForAgent } = require('../src/model/router');
      selectedTarget = resolveModelTargetForAgent(currentAgentContext, config);
      if (selectedTarget) {
        selectedTier = currentAgentContext.modelPreset;
      }
    } catch (e) {}
  }

  // Preserve existing complexity-based routing behavior as fallback
  if (!selectedTarget && (config.models || process.env.SMALLCODE_USE_TIER_ROUTING === 'true')) {
    try {
      const { routeToTier, estimateComplexity, isCompiledCognitionAvailable } = require('./cognition_adapter');
      if (isCompiledCognitionAvailable()) {
        const complexity = estimateComplexity(userMessage);
        const route = routeToTier(complexity);
        if (route) {
          if (config.models) {
            if (route.tier === 'trivial') selectedTarget = getModelTarget(config, 'fast');
            else if (route.tier === 'simple') selectedTarget = getModelTarget(config, 'default');
            else selectedTarget = getModelTarget(config, 'strong');
          }
          selectedTier = route.tier;
        }
      }
    } catch {}

    // Fallback: hand-rolled routeModel
    if (!selectedTarget && config.models) {
      try {
        const { routeTier } = require('../src/model/router');
        const tier = routeTier(userMessage);
        selectedTarget = getModelTarget(config, tier);
        selectedTier = tier;
      } catch {}
    }
  }

  if (selectedTarget && selectedTarget.model) {
    config.activeModelTarget = selectedTarget;
    if (_fullscreenRef && selectedTarget.model !== config.model.name) {
      _fullscreenRef.addTool('router', 'ok', `→ ${selectedTarget.model}${selectedTier ? ' (' + selectedTier + ')' : ''}`);
    }
  }

  let loopStepIndex = 0;

  try {
    const { getLedger } = require('../src/governor/run_ledger');
    currentLedgerRunId = getLedger().startRun({
      prompt: userMessage,
      model: config.activeModelTarget?.model || config.model?.name,
      taskType: currentTaskType,
      agentId: currentAgentContext ? currentAgentContext.agentId : null,
      modelPreset: currentAgentContext ? currentAgentContext.modelPreset : null,
    });

    if (currentLedgerRunId) {
      try {
        const { getActiveWorkspace, linkRunToWorkspace } = require('../src/governor/project_workspace');
        const activeId = getActiveWorkspace();
        if (activeId) {
          linkRunToWorkspace(activeId, currentLedgerRunId, {
            createdAt: Date.now(),
            taskType: currentTaskType,
            activeAgentId: currentAgentContext ? currentAgentContext.agentId : null,
            modelPreset: currentAgentContext ? currentAgentContext.modelPreset : null,
            promptPreview: userMessage
          });
        }
      } catch (wsErr) {
        // Workspace failure must not crash the harness
      }

      if (currentAgentContext) {
        getLedger().recordStep({
          runId: currentLedgerRunId,
          stepIndex: loopStepIndex++,
          stepType: 'agent_dispatch',
          name: currentAgentContext.name,
          durationMs: 0,
          success: true,
          summary: `Dispatched task to ${currentAgentContext.name} (${currentAgentContext.agentId}) with model preset: ${currentAgentContext.modelPreset}`
        });
      }
    }
  } catch (e) {
    currentLedgerRunId = null;
  }
  currentLedgerPromptTokens = 0;
  currentLedgerCompletionTokens = 0;

  // Deterministic tool routing: classify intent → filter tool schemas
  // Zero tokens, zero latency — compiled from marrow/tool_router.marrow
  try {
    const { classifyToolCategory, categoryNeedsTools } = require('../src/compiled/tool_router');
    // Affirmation guard: short confirmation messages (yes/ok/sure/go/proceed/
    // option N / work on N / first/second/etc.) should NOT reclassify the turn
    // as 'respond' — that would strip all tools right after the model proposed
    // an action it now wants to execute. Keep the prior turn's category so the
    // model still has the right tools available.
    const trimmedMsg = userMessage.trim();
    const isAffirmation = /^(yes|y|yep|yeah|sure|ok|okay|go|proceed|do it|continue|please|please do|alright|👍|✅)\b\s*\.?\s*$/i.test(trimmedMsg);
    const isContinuationRef = /^(option\s+\d|work\s+on\s+\d|do\s+\d|start\s+with\s+\d|\d+\.?\s*$|first|second|third|fourth|that|this|the\s+last|next)\b/i.test(trimmedMsg) && trimmedMsg.length < 30;
    const shouldKeepCategory = isAffirmation || isContinuationRef;
    if (shouldKeepCategory && currentToolCategory && currentToolCategory !== 'respond') {
      // Keep the existing category — don't re-classify
      if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `${currentToolCategory} (kept — continuation)`);
    } else {
      const routeResult = classifyToolCategory(userMessage);
      // If user said yes/ok/option-N and the previous category was respond/null,
      // default to 'plan' which gives a broad tool set so the model can execute.
      if (shouldKeepCategory && (!currentToolCategory || currentToolCategory === 'respond')) {
        currentToolCategory = 'plan';
        if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `plan (continuation default)`);
      } else {
        currentToolCategory = routeResult.category;
        if (_fullscreenRef && routeResult.confidence > 0.3) {
          _fullscreenRef.addTool('router', 'ok', `${routeResult.category} (${Math.round(routeResult.confidence * 100)}%)`);
        }
      }
    }
  } catch {
    currentToolCategory = null; // Fall back to all tools
  }

  // Feature 5: retrieve_context — auto-inject relevant files via code graph
  // Zero LLM calls; walks symbol graph from user message keywords
  try {
    if (retrieveContext && mcpCall) {
      const ctx = await retrieveContext(userMessage, mcpCall, 6);
      if (ctx && ctx.files && ctx.files.length > 0) {
        const contextHint = `[Auto-context: relevant files detected — ${ctx.files.slice(0, 4).join(', ')}]`;
        // Inject as a system hint into the last user message (non-intrusive)
        const lastUser = conversationHistory[conversationHistory.length - 1];
        if (lastUser && lastUser.role === 'user' && typeof lastUser.content === 'string') {
          lastUser.content = lastUser.content + '\n\n' + contextHint;
        }
        if (_fullscreenRef) _fullscreenRef.addTool('context', 'ok', `${ctx.files.length} files, ${ctx.symbols.length} symbols`);
      }
    }
  } catch {} // Never block on context retrieval



  // Auto-compact: estimate tokens and aggressively trim to stay within context window
  // Fix: trigger on EITHER token overflow OR message count (not just one condition for both).
  // For small-context models (8k-16k) the token check matters most.
  const estimatedTokens = estimateHistoryTokens(conversationHistory);
  const maxContextTokens = (config.context?.detected_window || 128000) * ((config.context?.max_budget_pct || 70) / 100);

  if (estimatedTokens > maxContextTokens * 0.8 || conversationHistory.length > 30) {
    // Phase B: Try MarrowScript-compiled compress_history first.
    // It produces a semantic summary instead of just dropping messages.
    let compressedSuccessfully = false;
    if (conversationHistory.length > 10) {
      try {
        const { compressHistoryCompiled, isCompiledCognitionAvailable } = require('./cognition_adapter');
        if (isCompiledCognitionAvailable()) {
          // Take oldest non-system messages, leave most recent 6 intact
          const recentCount = 6;
          const oldStart = conversationHistory.findIndex(m => m.role !== 'system');
          const oldEnd = conversationHistory.length - recentCount;
          if (oldStart >= 0 && oldEnd > oldStart) {
            const oldMessages = conversationHistory.slice(oldStart, oldEnd);
            const oldSerialized = oldMessages
              .map(m => {
                const role = m.role || 'unknown';
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                return `[${role}] ${content.slice(0, 1500)}`;
              })
              .join('\n\n');
            const targetTokens = Math.max(200, Math.min(1500, Math.floor(maxContextTokens * 0.05)));
            const summary = await compressHistoryCompiled(oldSerialized, targetTokens);
            if (summary && summary.length > 0) {
              // Replace old messages with a single summary system message
              conversationHistory.splice(oldStart, oldEnd - oldStart, {
                role: 'system',
                content: `[Compressed summary of ${oldMessages.length} earlier messages]\n${summary}`,
              });
              compressedSuccessfully = true;
              console.log(tui.compacted(conversationHistory.length));
            }
          }
        }
      } catch {}
    }

    // Fallback: drop oldest non-system messages until under budget
    if (!compressedSuccessfully) {
      while (conversationHistory.length > 6) {
        const currentEst = estimateHistoryTokens(conversationHistory);
        // Fix #19: Always compact until under 70% of budget. The old condition
        // `&& conversationHistory.length <= 20` would stop compacting at 20
        // messages even if still way over budget (e.g. 20 messages of 2000 tokens each).
        if (currentEst < maxContextTokens * 0.7) break;
        const removeIdx = conversationHistory.findIndex(m => m.role !== 'system');
        if (removeIdx === -1) break;
        conversationHistory.splice(removeIdx, 1);
      }
      const summary = `[Context compacted to fit ${Math.round(maxContextTokens)} token budget]`;
      conversationHistory.unshift({ role: 'system', content: summary });
      console.log(tui.compacted(conversationHistory.length));
    }
  }

  let toolCallsThisTurn = 0;
  let _editedFilesThisTurn = []; // track files written/patched for reviewer
  let _reviewerPromise = null;   // reviewer async promise, awaited at turn end

  // Await planner result (Feature #15) and inject into conversation as a system
  // message if it produced a valid plan. This happens ONCE before the first
  // chatCompletion call — the await here is cheap since we started the request
  // concurrently with task classification above.
  let _plannerInjected = false;
  try {
    if (_plannerPromise) {
      const plan = await _plannerPromise;
      if (plan) {
        const { formatPlannerInjection } = require('../src/model/chain');
        const injection = formatPlannerInjection(plan);
        if (injection) {
          conversationHistory.push({ role: 'system', content: injection });
          _plannerInjected = true;
          if (_fullscreenRef) _fullscreenRef.addTool('chain', 'ok', `planner: ${plan.split('\n').length} steps`);
        }
      }
    }
  } catch {}

  // loopStepIndex initialized earlier
  while (toolCallsThisTurn < MAX_TOOL_CALLS) {
    // Mid-turn context check: if history is getting too large, evict old tool results
    // This prevents context overflow during long tool-call chains
    if (toolCallsThisTurn > 0 && toolCallsThisTurn % 3 === 0) {
      let midEst = estimateHistoryTokens(conversationHistory);
      const maxBudget = (config.context?.detected_window || 128000) * 0.6;
      if (midEst > maxBudget) {
        // Fix #14: First pass — truncate large tool_call arguments in OLD assistant
        // messages (not the most recent one). After the tool result has been received,
        // the model doesn't need the full write_file content in arguments anymore.
        const lastAssistantIdx = conversationHistory.reduce((last, m, i) => m.tool_calls ? i : last, -1);
        for (let i = 0; i < lastAssistantIdx; i++) {
          const m = conversationHistory[i];
          if (!m.tool_calls) continue;
          for (const tc of m.tool_calls) {
            if (tc.function && tc.function.arguments && tc.function.arguments.length > 200) {
              const saved = tc.function.arguments.length;
              // Replace with minimal valid JSON that preserves the tool name context.
              // Defensive: if arguments are already invalid JSON (from a prior truncation
              // pass that produced '...' suffixes), just replace with '{}' directly.
              try {
                const parsed = JSON.parse(tc.function.arguments);
                const minimal = {};
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === 'string' && v.length > 100) {
                    minimal[k] = v.slice(0, 80) + '…';
                  } else {
                    minimal[k] = v;
                  }
                }
                tc.function.arguments = JSON.stringify(minimal);
              } catch {
                // Already invalid JSON — reset to empty object to avoid cascading
                // parse failures on subsequent passes or API calls.
                tc.function.arguments = '{}';
              }
              midEst -= Math.ceil((saved - tc.function.arguments.length) / 4);
            }
          }
        }

        let evicted = 0;
        for (let i = 0; i < conversationHistory.length && midEst > maxBudget * 0.7; i++) {
          if (conversationHistory[i].role === 'tool') {
            const tcId = conversationHistory[i].tool_call_id;
            // Only evict if the corresponding assistant message was also evicted
            // (i.e. its tool_call_id is no longer referenced). To be safe in
            // one pass, we evict tool+assistant pairs from the oldest end:
            // find the assistant message that owns this tool result.
            let ownerIdx = -1;
            for (let j = i - 1; j >= 0; j--) {
              if (conversationHistory[j].tool_calls &&
                  conversationHistory[j].tool_calls.some(tc => tc.id === tcId)) {
                ownerIdx = j;
                break;
              }
            }
            // Only evict if the owner is in the first half of history (old enough)
            // AND we can remove the pair together. Otherwise skip to avoid orphaning.
            if (ownerIdx >= 0 && ownerIdx < conversationHistory.length / 2) {
              // Replace the tool result with a compact summary
              const content = conversationHistory[i].content || '';
              const len = Math.ceil(content.length / 4);
              conversationHistory[i].content = `[evicted: ${len} tokens]`;
              midEst -= len - 5;
              evicted++;
            } else if (ownerIdx === -1) {
              // Orphaned tool result (owner already gone) — safe to remove
              const len = Math.ceil((conversationHistory[i].content || '').length / 4);
              conversationHistory.splice(i, 1);
              midEst -= len;
              evicted++;
              i--;
            }
          }
        }
        if (evicted > 0) tokenMonitor.recordEviction();
      }
    }

    const modelStart = Date.now();
    const response = await chatCompletion(config, conversationHistory);
    const modelDuration = Date.now() - modelStart;

    if (response && response.usage && currentLedgerRunId) {
      currentLedgerPromptTokens += response.usage.prompt_tokens || 0;
      currentLedgerCompletionTokens += response.usage.completion_tokens || 0;
    }

    if (currentLedgerRunId) {
      try {
        const { getLedger } = require('../src/governor/run_ledger');
        const message = response?.choices?.[0]?.message;
        const summary = message?.content ? message.content.slice(0, 100) : (response ? 'Model generated tool calls or response' : 'No response from model');
        getLedger().recordStep({
          runId: currentLedgerRunId,
          stepIndex: loopStepIndex++,
          stepType: 'model_response',
          name: response?.model || config.model.name,
          durationMs: modelDuration,
          success: !!response,
          summary,
        });
      } catch (e) {}
    }

    if (!response) {
      console.log('  \x1b[31m✗ No response from model\x1b[0m');
      updateFailureState(failureState, { type: 'model_failure' });
      const escalated = triggerAgentEscalation('model_failure');
      if (escalated) {
        if (escalated === 'terminal') {
          terminalFailureReached = true;
          break;
        }
        continue;
      }
      break;
    }

    const message = response.choices?.[0]?.message;
    if (!message) break;

    // Defensive recovery: some local models (qwen2.5-coder, hermes, llama3
    // GGUFs) emit tool calls as JSON inside `content` instead of populating
    // structured `tool_calls`. Try to lift them into the proper field
    // before any downstream logic looks at the message. Issue #36.
    try {
      const { extractFromMessage } = require('../src/tools/tool_call_extractor');
      const r = extractFromMessage(message, getAllTools(config, currentToolCategory));
      if (r.patched && _fullscreenRef) {
        _fullscreenRef.addTool('tool_call', 'ok', `recovered ${r.addedCalls} from text content`);
      }
    } catch {}

    // Extract and optionally display thinking content before it enters history.
    // Reasoning models (Qwen3, DeepSeek R1, Gemma 4) emit <think>...</think>
    // blocks before their answer. We:
    //   1. Extract the thinking so it can be shown in the TUI (dimmed/collapsed)
    //   2. Hard-cap it so 50KB of "let me reconsider" loops don't bloat history
    //   3. Store only the answer in conversation history (thinking is ephemeral)
    //
    // Enable display with SMALLCODE_SHOW_THINKING=true (default: false).
    // The thinking is always stripped from history regardless of this flag.
    if (message.content && typeof message.content === 'string') {
      try {
        const { extractThinking, truncateThinking, estimateThinkingTokens } = require('../src/model/thinking_budget');
        const { thinking, answer } = extractThinking(message.content);
        const beforeTokens = estimateThinkingTokens(message.content);

        if (thinking) {
          const showThinking = process.env.SMALLCODE_SHOW_THINKING === 'true';
          if (showThinking) {
            const thinkingTokens = estimateThinkingTokens(`<think>${thinking}</think>`);
            if (_fullscreenRef) {
              _fullscreenRef.addTool('thinking', 'ok', `${thinkingTokens}t`);
              const preview = thinking.length > 300 ? thinking.slice(0, 300) + '…' : thinking;
              _fullscreenRef.addChat('system', `\x1b[2m[thinking]\n${preview}\x1b[0m`);
            } else {
              const thinkingLines = thinking.split('\n').map(l => `  \x1b[2m${l}\x1b[0m`).join('\n');
              process.stdout.write(`\n\x1b[2m[thinking — ${thinkingTokens}t]\x1b[0m\n${thinkingLines}\n\n`);
            }
          } else if (beforeTokens > 100 && _fullscreenRef) {
            _fullscreenRef.addTool('thinking', 'ok', `${beforeTokens}t (set SMALLCODE_SHOW_THINKING=true to view)`);
          }
          // Replace message content with just the answer for history storage
          message.content = answer;
        }

        // Emergency hard-cap for unclosed/malformed thinking tags
        const afterTokens = estimateThinkingTokens(message.content);
        if (afterTokens > 500) {
          message.content = truncateThinking(message.content);
          if (_fullscreenRef) {
            _fullscreenRef.addTool('thinking', 'err', `truncated ${afterTokens}t → ${estimateThinkingTokens(message.content)}t`);
          }
        }
      } catch {}
    }
    // Transition restricted agents (like repo_navigator or conductor) immediately if they attempt code writing or shell execution.
    if (message.tool_calls && message.tool_calls.length > 0 && currentAgentContext) {
      const hasWriteOrShellTool = message.tool_calls.some(tc => {
        const name = tc?.function?.name || '';
        const { classifyTool } = require('../src/governor/agent_registry');
        const c = classifyTool(name);
        return (c.isFileWrite && !currentAgentContext.canEditFiles) || (c.isShell && !currentAgentContext.canRunShell);
      });
      if (hasWriteOrShellTool) {
        failureState.denials = Math.max(failureState.denials, 2);
        const escalated = triggerAgentEscalation('authorization_denial', { toolName: message.tool_calls[0].function.name });
        if (escalated) {
          if (escalated === 'terminal') {
            terminalFailureReached = true;
            break;
          }
          conversationHistory.push({ role: 'system', content: `[AGENT-TRANSITION] Transitioned to ${currentAgentContext.name} agent. Re-read the tool schemas and invoke them with correct arguments.` });
          continue;
        }
      }
    }

    // ── QUALITY MONITOR (itsy port) ──────────────────────────────────────
    // Catches structural failure modes the model emitted on this turn:
    // empty turns, blank tool names, hallucinated tool names, and exact
    // cross-turn repeats. On a hit we inject a targeted steer and continue;
    // on the third consecutive correction we back off so other guards
    // (early_stop / escalation) can take over. Disable with
    // SMALLCODE_QUALITY_MONITOR=false.
    try {
      if (String(process.env.SMALLCODE_QUALITY_MONITOR || 'true').toLowerCase() !== 'false') {
        const knownTools = getAllTools(config, currentToolCategory)
          .map(t => t && t.function && t.function.name)
          .filter(Boolean);
        const signal = qualityMonitor.inspect({ message, knownTools });
        if (signal) {
          if (_fullscreenRef) _fullscreenRef.addTool('quality', 'warn', signal.kind);
          else console.log(`  \x1b[33m⚠ quality-monitor: ${signal.kind}\x1b[0m`);
          conversationHistory.push({ role: 'assistant', content: message.content || '' });
          conversationHistory.push({ role: 'user', content: signal.injection });
          continue;
        }
      }
    } catch {}

    // If model wants to call tools
    if (message.tool_calls && message.tool_calls.length > 0) {
      // After first tool call, widen tool set for subsequent iterations.
      // If the model just called select_category, currentToolCategory was already
      // set to the selected category by the handler below. Otherwise, widen to
      // 'plan' which in the compiled router maps to all essential tools.
      const firstToolName = message.tool_calls[0]?.function?.name;
      if (firstToolName !== 'select_category') {
        currentToolCategory = 'plan';
      }

      // Add assistant message with tool calls to history.
      // Fix #14: We store the ORIGINAL message here (it must have valid JSON args
      // for the next API call to work). The context savings come from the mid-turn
      // eviction and compaction logic, not from corrupting args mid-conversation.
      // However, once a tool_call has been fully processed (tool result received),
      // we'll truncate large args in the stored message during mid-turn eviction.
      //
      // Poisoned-history fix: snapshot history length BEFORE pushing the assistant
      // message + tool results. If every tool call in this turn returns a validation
      // error, we revert to this length and inject a single user-role correction —
      // preventing the model's malformed output from biasing the retry.
      const __preTurnHistoryLen = conversationHistory.length;
      const __validationErrors = [];

      conversationHistory.push(message);
      let escalatedThisTurn = false;

      // Plan extraction (Feature 8): if the model emitted a plan in its
      // textual content, capture it now so subsequent turns can re-inject it.
      try {
        if (_planTracker && _planTracker.needsPlan() && message.content) {
          // MarrowScript Feature #3: use async LLM-based plan extractor with regex fallback
          if (await _planTracker.ingestResponseAsync(message.content)) {
            if (_fullscreenRef) _fullscreenRef.addTool('plan', 'ok', `${_planTracker.plan.length} steps`);
            // Remove the one-shot instruction now that we have the plan.
            // It must not persist in history or the model will keep trying
            // to write a plan on every subsequent chatCompletion call.
            if (_planInstructionIdx >= 0 && _planInstructionIdx < conversationHistory.length) {
              const msg = conversationHistory[_planInstructionIdx];
              if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
                  msg.content.includes('numbered plan')) {
                conversationHistory.splice(_planInstructionIdx, 1);
              }
              _planInstructionIdx = -1;
            }

            // Feature 4: validate file paths mentioned in the plan.
            // Advisory only — injects a warning system message so the model
            // can self-correct via find_files rather than hard-failing.
            try {
              const { validatePlanPaths, buildDependencyGraph, toParallelBatches, formatBatchSummary } = require('../src/session/dependency_graph');
              const { missing } = validatePlanPaths(_planTracker.plan, process.cwd());
              if (missing.length > 0) {
                const warnMsg = `[PATH-VALIDATION] Plan references files that don't exist on disk: ${missing.join(', ')}. ` +
                  `Use find_files or bash to locate the correct paths before proceeding.`;
                conversationHistory.push({ role: 'system', content: warnMsg });
                if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', `missing paths: ${missing.join(', ')}`);
              }

              // Feature 3: build dependency graph and log batch structure to TUI
              const graph = buildDependencyGraph(_planTracker.plan, process.cwd());
              const batches = toParallelBatches(graph, _planTracker.plan.length);
              _planTracker._executionBatches = batches;
              if (_fullscreenRef && batches.length > 0) {
                _fullscreenRef.addTool('plan', 'ok', formatBatchSummary(batches));
              }
            } catch {}
          }
        }
      } catch {}

      for (const tc of message.tool_calls) {
        toolCallsThisTurn++;
        const toolName = tc.function.name;
        let toolArgs;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          // Feature 1: repair malformed tool args via compiled repair_tool_call prompt
          let repaired = false;
          if (repairToolCall) {
            try {
              const toolDef = ALL_TOOLS.find(t => t.function.name === toolName);
              const schema = toolDef ? JSON.stringify(toolDef.function.parameters).slice(0, 500) : '';
              const repair = await repairToolCall(tc.function.arguments, 'Invalid JSON', schema);
              if (repair.ok && repair.repairedCall) {
                try {
                  toolArgs = JSON.parse(repair.repairedCall);
                  repaired = true;
                  if (_fullscreenRef) _fullscreenRef.addTool('repair', 'ok', `repaired ${toolName} args`);
                } catch {}
              }
            } catch {}
          }
          if (!repaired) {
            // Last-resort fallback for write_file: try regex extraction of path + content
            // before giving up entirely. The most common failure mode is a large file
            // content with unescaped quotes that breaks JSON.parse — we can often still
            // extract the path and a truncated content.
            if (toolName === 'write_file' && typeof tc.function.arguments === 'string') {
              try {
                const raw = tc.function.arguments;
                const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
                const contentMatch = raw.match(/"content"\s*:\s*"([\s\S]+?)(?=",\s*"|\s*}\s*$)/);
                if (pathMatch) {
                  // Unescape basic JSON escape sequences
                  const unescape = s => s
                    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '')
                    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                  toolArgs = {
                    path: pathMatch[1],
                    content: contentMatch ? unescape(contentMatch[1]) : '',
                  };
                  repaired = true;
                  if (_fullscreenRef) _fullscreenRef.addTool('repair', 'ok', `regex-extracted write_file args`);
                  else console.log(`  \x1b[33m⚠ Repaired write_file args via regex extraction\x1b[0m`);
                }
              } catch {}
            }
            if (!repaired) {
              toolArgs = {};
              console.log(`  \x1b[31m✗ Failed to parse args for ${toolName}\x1b[0m`);
            }
          }
        }

        // Show what's happening
        process.stdout.write(tui.toolStart(toolName));
        const toolStart2 = Date.now();

        const argsSummary = toolArgs.command
          ? `command: ${toolArgs.command}`
          : toolArgs.path
            ? `path: ${toolArgs.path}`
            : toolArgs.pattern
              ? `pattern: ${toolArgs.pattern}`
              : JSON.stringify(toolArgs);
        logEvent(EVENT_TYPES.TOOL_CALL, {
          tool: toolName,
          id: tc.id,
          argsSummary: String(argsSummary || '').slice(0, 500),
        });

        const result = await executeTool(toolName, toolArgs);
        const toolMs = Date.now() - toolStart2;

        const resultSummary = result.error
          ? `error: ${result.error}`
          : result.result
            ? String(result.result).slice(0, 500)
            : (result.action ? `${result.action} ${result.path || ''}` : 'success');
        logEvent(EVENT_TYPES.TOOL_RESULT, {
          tool: toolName,
          id: tc.id,
          success: !result.error,
          durationMs: toolMs,
          summary: resultSummary,
        });

        const toolExecEvent = {
          type: 'tool_execution',
          name: toolName,
          args: toolArgs,
          result: result
        };
        updateFailureState(failureState, toolExecEvent);
        const classified = classifyFailureEvent(toolExecEvent);
        if (classified) {
          const escalated = triggerAgentEscalation(classified, { toolName });
          if (escalated) {
            if (escalated === 'terminal') {
              terminalFailureReached = true;
              break;
            }
            escalatedThisTurn = true;
            break;
          }
        }

        if (toolCallsThisTurn >= MAX_TOOL_CALLS) {
          updateFailureState(failureState, { type: 'max_tool_calls' });
          const escalated = triggerAgentEscalation('max_tool_calls');
          if (escalated) {
            if (escalated === 'terminal') {
              terminalFailureReached = true;
              break;
            }
            toolCallsThisTurn = 0;
            escalatedThisTurn = true;
            break;
          }
        }

        // Track validation errors so the poisoned-history fix can revert
        // bad assistant turns where the model emitted malformed tool args.
        if (result && result.kind === 'validation') {
          __validationErrors.push(`${toolName}: ${result.error}`);
        }

        // Handle select_category: update the tool category so the NEXT
        // chatCompletion call injects the right tool schemas for stage 2.
        if (toolName === 'select_category' && result.category) {
          currentToolCategory = result.category;
        }

        // Record trace step
        traceRecorder.recordToolCall(toolName, toolArgs, result.result || result.error || '', toolMs);

        // Track edited files for reviewer agent (Feature #18)
        if ((toolName === 'write_file' || toolName === 'patch') && !result.error && toolArgs.path) {
          _editedFilesThisTurn.push(toolArgs.path);
          // MarrowScript Rank 6: inject multi-file coordination header when editing 3+ files
          if (_editedFilesThisTurn.length >= 3) {
            try {
              const { coordinateMultiFileEdit } = require('../src/compiled/features/multi_file_edit');
              const { getSnapshotManager } = require('../src/session/snapshot');
              const snap = getSnapshotManager({ workdir: process.cwd() });
              await coordinateMultiFileEdit(userMessage, _editedFilesThisTurn, conversationHistory, executeTool, snap);
            } catch {} // never block on coordination errors
          }
        }

        // Trust decay (Feature 13): track consecutive failures per tool.
        // Dropped tools are filtered out of the schema list on the next
        // chatCompletion via getAllTools() → filterAndSort().
        try {
          const { getTrustDecay } = require('../src/tools/trust_decay');
          getTrustDecay().record(toolName, !result.error);
        } catch {}

        // Show result indicators
        if (result.error) {
          console.log(tui.toolError(result.error));
        } else if (result.action === 'Created') {
          console.log(tui.toolCreated(result.path, result.lines, toolMs));
        } else if (result.action === 'Updated') {
          console.log(tui.toolUpdated(result.path, result.lines, toolMs));
        } else if (result.action === 'Edited') {
          console.log(tui.toolEdited(result.path, result.line, toolMs));
        } else if (result.command) {
          console.log(tui.toolBash(result.command, toolMs));
        } else {
          console.log(tui.toolSuccess('', toolMs));
        }

        // Add tool result to history (cap to prevent context explosion).
        // The read-guard returns either the original content (under cap),
        // a head/tail trim with an explicit "re-read a smaller range" hint,
        // or — when context is already pressured — a head-only trim that
        // tells the model to grep first instead of re-reading. See
        // src/session/read_guard.js for the rationale.
        // Override with SMALLCODE_MAX_TOOL_RESULT_CHARS env var.
        const toolContent = result.result || result.error || '';
        const maxToolResultChars = parseInt(process.env.SMALLCODE_MAX_TOOL_RESULT_CHARS) || 8000;
        const headLines = parseInt(process.env.SMALLCODE_READ_GUARD_HEAD_LINES) || 30;
        const guardOff = String(process.env.SMALLCODE_READ_GUARD || 'true').toLowerCase() === 'false';
        let cappedContent;
        if (guardOff) {
          cappedContent = toolContent.length > maxToolResultChars
            ? toolContent.slice(0, maxToolResultChars - 200) + '\n\n...(truncated, ' + toolContent.length + ' chars total)...\n' + toolContent.slice(-200)
            : toolContent;
        } else {
          const guard = applyReadGuard({
            toolName,
            content: toolContent,
            history: conversationHistory,
            config,
            fixedCap: maxToolResultChars,
            headLines,
          });
          cappedContent = guard.content;
          if (guard.trimmed && _fullscreenRef) {
            _fullscreenRef.addTool('read_guard', 'warn', `${guard.reason}: ${toolContent.length}→${cappedContent.length} chars`);
          }
        }
        conversationHistory.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: cappedContent,
        });

        // ── IMPROVEMENT LOOP: auto-validate writes and feed errors back ──
        // Uses MarrowScript-compiled bounded loop for iteration control + tracing
        if ((toolName === 'write_file' || toolName === 'patch') && !result.error) {
          const filePath = toolArgs.path;

          // Feature 6: self-critique the edit before running lint
          try {
            if (validateEditCompiled && filePath) {
              const written = fs.existsSync(path.resolve(process.cwd(), filePath))
                ? fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8')
                : (toolArgs.content || '');
              const critique = await validateEditCompiled(filePath, written, userMessage);
              if (!critique.ok && critique.issues.length > 0) {
                if (_fullscreenRef) _fullscreenRef.addTool('critique', 'err', critique.issues[0].slice(0, 80));
                // Inject semantic issue as additional context for the improvement loop
                conversationHistory.push({ role: 'user', content: `[SEMANTIC-REVIEW] Potential issue in ${filePath}: ${critique.issues[0]}` });
              }
            }
          } catch {} // Never block on self-critique

          const validation = runValidation(filePath);
          if (validation && !validation.passed) {
            // Track how many times we've tried fixing this file
            if (!improvementAttempts[filePath]) improvementAttempts[filePath] = 0;
            improvementAttempts[filePath]++;

            // Token monitor: record validation failure (counts as improvement overhead)
            tokenMonitor.recordCompaction(); // Reuse compaction counter for improvement overhead tracking

            if (improvementAttempts[filePath] <= MAX_IMPROVE_ITERATIONS) {
              const attempt = improvementAttempts[filePath];
              console.log(tui.improvementLoop(validation.errors, attempt, MAX_IMPROVE_ITERATIONS));

              // Track attempt history for this file
              if (!improvementAttempts[`__history:${filePath}`]) improvementAttempts[`__history:${filePath}`] = [];
              improvementAttempts[`__history:${filePath}`].push({
                attempt,
                errors: validation.errors.slice(0, 3),
              });

              // Build fix prompt with full retry history
              let fixPrompt;
              const history = improvementAttempts[`__history:${filePath}`];
              const historyStr = history.length > 1
                ? `\n\nPrevious attempts (${history.length - 1} failed):\n` + history.slice(0, -1).map((h, i) => `  Attempt ${i + 1}: ${h.errors[0] || 'unknown error'}`).join('\n')
                : '';

              if (attempt <= 2) {
                // Include the test command if we have one, so the model can verify its own fix
                let testHint = '';
                try {
                  if (_testRunnerDetector) {
                    const r = _testRunnerDetector.detect();
                    if (r) testHint = `\n\nAfter fixing, run \`${r.command}\` to verify.`;
                  }
                } catch {}
                fixPrompt = `[AUTO-VALIDATE] Errors in ${filePath} (attempt ${attempt}/${MAX_IMPROVE_ITERATIONS}):
${validation.errors.join('\n')}${historyStr}${testHint}

Fix these errors. Do NOT repeat the same approach that failed before.`;
              } else {
                // Escalated: show the full file + errors + history
                // CAP file content to ~2000 tokens (8000 chars) to prevent context blow-up.
                // On small-context models (8k-16k) injecting a 5000-line file is fatal.
                let fileContent = '';
                try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}
                const maxFileChars = Math.min(8000, Math.floor(((config.context?.detected_window || 32768) * 0.15) * 4));
                const cappedFile = fileContent.length > maxFileChars
                  ? fileContent.slice(0, maxFileChars) + `\n... (${Math.ceil((fileContent.length - maxFileChars)/4)} more tokens truncated)`
                  : fileContent;
                fixPrompt = `[AUTO-VALIDATE] After ${attempt} attempts, ${filePath} still has errors.${historyStr}

FULL FILE CONTENT:
\`\`\`
${cappedFile}
\`\`\`

ERRORS:
${validation.errors.join('\n')}

Read the FULL file above carefully. Fix ALL errors. Use the patch tool with the exact text from the file. Do NOT repeat previous failed approaches.`;
              }

              conversationHistory.push({ role: 'user', content: fixPrompt });
            } else {
              // DECOMPOSE instead of giving up — break the problem into chunks
              improvementAttempts[filePath] = 0;
              let fileContent = '';
              try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}

              // MarrowScript Rank 5: try LLM-based decompose strategy first
              let strategy;
              try {
                const { decomposeTask } = require('./features_adapter');
                if (decomposeTask) {
                  const errStr = validation.errors.join('\n');
                  const decomposeResult = await decomposeTask(userMessage, errStr, fileContent.slice(0, 1000));
                  if (decomposeResult) strategy = { type: decomposeResult.strategy, reason: decomposeResult.reason, instruction: decomposeResult.instruction };
                }
              } catch {}
              // Fall back to governor's regex strategy
              if (!strategy) {
                const { pickDecomposeStrategy } = require('./governor');
                strategy = pickDecomposeStrategy(fileContent, validation.errors, filePath);
              }
              
              // Track decompose attempts — if this is the 2nd decompose, escalate instead
              if (!improvementAttempts[`__decompose:${filePath}`]) improvementAttempts[`__decompose:${filePath}`] = 0;
              improvementAttempts[`__decompose:${filePath}`]++;

              if (improvementAttempts[`__decompose:${filePath}`] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
                // Decompose has been tried and failed — ESCALATE to stronger model
                console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — local model exhausted\x1b[0m`);
                
                // Cap file content for escalation to prevent context overflow on the
                // escalation model too (which has its own context limit).
                const maxEscFileChars = 12000;
                const cappedEscFile = fileContent.length > maxEscFileChars
                  ? fileContent.slice(0, maxEscFileChars) + `\n... (truncated, ${fileContent.split('\n').length} lines total)`
                  : fileContent;
                const escalationPrompt = `Fix these errors in ${filePath}. The code:\n\`\`\`\n${cappedEscFile}\n\`\`\`\n\nErrors:\n${validation.errors.join('\n')}\n\nPrevious attempts failed. Fix it correctly.`;
                const escalationMessages = [
                  ...conversationHistory.slice(-6), // Recent context
                  { role: 'user', content: escalationPrompt },
                ];
                
                const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
                
                if (escalatedResponse && !escalatedResponse.error) {
                  // Inject the escalated response back into the conversation
                  if (escalatedResponse.tool_calls) {
                    conversationHistory.push(escalatedResponse);
                    // Execute the escalated model's tool calls
                    for (const tc of escalatedResponse.tool_calls) {
                      const eName = tc.function.name;
                      let eArgs;
                      try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                      process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                      process.stdout.write(tui.toolStart(eName));
                      const eResult = await executeTool(eName, eArgs);
                      if (eResult.error) {
                        console.log(tui.toolError(eResult.error));
                      } else if (eResult.action) {
                        console.log(tui.toolSuccess(`${eResult.action} ${eResult.path || ''}`, 0));
                      } else {
                        console.log(tui.toolSuccess('', 0));
                      }
                      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                    }
                  } else if (escalatedResponse.content) {
                    conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                    process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                  }
                  improvementAttempts[`__decompose:${filePath}`] = 0;
                } else {
                  // Escalation also failed — give up gracefully
                  const errMsg = escalatedResponse?.error || 'No response';
                  console.log(`  \x1b[31m✗ Escalation failed: ${errMsg}\x1b[0m`);
                  // Auto-rollback (Feature 9, opt-in via SMALLCODE_SNAPSHOT_AUTO_ROLLBACK=true).
                  // Validation has hard-failed and even the stronger model couldn't fix it
                  // — better to revert to a known-good state than leave half-broken files.
                  try {
                    const { getSnapshotManager } = require('../src/session/snapshot');
                    const snap = getSnapshotManager();
                    if (snap.autoRollback && snap.isActive()) {
                      const r = snap.rollback('escalation+improvement-loop exhausted');
                      console.log(`  \x1b[33m↶ Auto-rollback: restored ${r.restored}, deleted ${r.deleted}\x1b[0m`);
                      conversationHistory.push({
                        role: 'user',
                        content: `[AUTO-ROLLBACK] All edits in this turn have been reverted because validation kept failing. The workspace is back to its pre-turn state. Re-read files before retrying.`,
                      });
                    }
                  } catch {}
                  conversationHistory.push({
                    role: 'user',
                    content: `[ESCALATION FAILED] Even the stronger model couldn't fix this. Deliver the best version you have and explain what's still broken.`,
                  });
                }
              } else {
                // First decompose attempt — try the local model with a new strategy
                console.log(`  \x1b[33m◇ DECOMPOSE: ${strategy.reason}\x1b[0m`);
                console.log(`  \x1b[90m  Strategy: ${strategy.type}\x1b[0m`);
                
                conversationHistory.push({
                  role: 'user',
                  content: `[DECOMPOSE] After ${MAX_IMPROVE_ITERATIONS} failed fix attempts, changing strategy.\n\n${strategy.instruction}`,
                });
              }
            }
          } else if (validation && validation.passed) {
            if (improvementAttempts[filePath] > 0) {
              console.log(tui.improvementFixed(filePath, improvementAttempts[filePath]));
              improvementAttempts[filePath] = 0;
            }
          }
        }

        // ── IMPROVEMENT LOOP: auto-validate bash/run commands that fail ──
        if ((toolName === 'bash' || toolName === 'run' || toolName === 'create_and_run') && result.error) {
          if (!improvementAttempts['__bash']) improvementAttempts['__bash'] = 0;
          improvementAttempts['__bash']++;

          if (improvementAttempts['__bash'] <= 2) {
            // Fix #5: Cap error output to 800 chars (~200 tokens) to prevent
            // context accumulation. The full output is already in the tool result.
            const cappedError = (result.result || '').slice(0, 800);
            conversationHistory.push({
              role: 'user',
              content: `[AUTO-FIX] The command FAILED (attempt ${improvementAttempts['__bash']}/2). Do NOT claim success. The error was:\n${cappedError}\n\nRead the error, identify the bug, and fix it.`,
            });
          } else {
            // DECOMPOSE: bash keeps failing, break the problem apart
            if (!improvementAttempts['__decompose:bash']) improvementAttempts['__decompose:bash'] = 0;
            improvementAttempts['__decompose:bash']++;

            if (improvementAttempts['__decompose:bash'] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
              // Bash decompose failed twice — escalate
              console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — command keeps failing\x1b[0m`);
              improvementAttempts['__bash'] = 0;
              improvementAttempts['__decompose:bash'] = 0;

              const escalationMessages = [
                ...conversationHistory.slice(-8),
                { role: 'user', content: `The command keeps failing. Fix the underlying issue. Error: ${(result.result || '').slice(0, 1500)}` },
              ];
              
              const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
              if (escalatedResponse && !escalatedResponse.error) {
                if (escalatedResponse.tool_calls) {
                  conversationHistory.push(escalatedResponse);
                  for (const tc of escalatedResponse.tool_calls) {
                    const eName = tc.function.name;
                    let eArgs;
                    try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                    process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                    process.stdout.write(tui.toolStart(eName));
                    const eResult = await executeTool(eName, eArgs);
                    if (eResult.error) {
                      console.log(tui.toolError(eResult.error));
                    } else {
                      console.log(tui.toolSuccess('', 0));
                    }
                    conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                  }
                } else if (escalatedResponse.content) {
                  conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                  process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                }
              } else {
                console.log(`  \x1b[31m✗ Escalation failed\x1b[0m`);
                conversationHistory.push({
                  role: 'user',
                  content: `[ESCALATION FAILED] Move on. Explain what you tried and what's still broken.`,
                });
              }
            } else {
              // First bash decompose — try local model with new strategy
              improvementAttempts['__bash'] = 0;
              // MarrowScript Rank 5: try LLM-based decompose strategy first
              let strategy;
              try {
                const { decomposeTask } = require('./features_adapter');
                if (decomposeTask) {
                  const bashErrors = [(result.result || '').slice(0, 300)].join('\n');
                  const decomposeResult = await decomposeTask(userMessage, bashErrors, toolArgs.command || '');
                  if (decomposeResult) strategy = { type: decomposeResult.strategy, reason: decomposeResult.reason, instruction: decomposeResult.instruction };
                }
              } catch {}
              if (!strategy) {
                const { pickDecomposeStrategy } = require('./governor');
                const errors = [(result.result || '').slice(0, 300)];
                strategy = pickDecomposeStrategy('', errors, toolArgs.command || '');
              }
              console.log(`  \x1b[33m◇ DECOMPOSE: Command keeps failing. Changing approach.\x1b[0m`);
              conversationHistory.push({
                role: 'user',
                content: `[DECOMPOSE] The command has failed 3 times. STOP retrying the same approach.\n\n${strategy.instruction}`,
              });
            }
          }
        } else if ((toolName === 'bash' || toolName === 'run') && !result.error) {
          improvementAttempts['__bash'] = 0;
        }

        // ── GOVERNOR: Record tool success/failure for Bayesian learning ──
        if (!result.error) {
          toolScorer.recordSuccess(toolName, currentTaskType, toolMs);
        } else {
          toolScorer.recordFailure(toolName, currentTaskType, result.error || 'unknown');
        }

        // ── EARLY-STOP: Detect patch spiral (model stuck on corrupted file) ──
        if (toolName === 'patch' || toolName === 'read_and_patch') {
          const patchSuccess = !result.error;
          const patchFile = toolArgs.path;
          const stopSignal = earlyStop.recordPatchResult(patchFile, patchSuccess, toolArgs.old_str, toolArgs.new_str);
          if (stopSignal) {
            console.log(`  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
            conversationHistory.push({ role: 'user', content: stopSignal.injection });
            // Don't continue with normal flow — force model to rewrite
            break;
          }
        }

        // ── EARLY-STOP: Detect read loop (model endlessly reading without producing output) ──
        {
          const hasWrittenAnything = _editedFilesThisTurn.length > 0;
          const readLoopSignal = earlyStop.recordReadTool(toolName, hasWrittenAnything);
          if (readLoopSignal) {
            console.log(`  \x1b[33m⚡ ${readLoopSignal.message}\x1b[0m`);
            if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', 'read loop — nudging toward output');
            conversationHistory.push({ role: 'user', content: readLoopSignal.injection });
            // For the hard stop (8 reads), break the loop to force a response
            if (readLoopSignal.reason === 'read_loop') break;
            // For the soft nudge (5 reads), let the model continue with the nudge injected
          }
        }

        // ── PLUGINS: Fire post_tool hooks ──
        if (pluginLoader && pluginLoader.hooks.length > 0) {
          for (const hook of pluginLoader.hooks) {
            if (hook.event === 'post_tool' && hook.handler) {
              if (hook.filter.length === 0 || hook.filter.includes(toolName)) {
                try { await hook.handler({ tool: toolName, args: toolArgs, result, ms: toolMs }); } catch {}
              }
            }
          }
        }
      }

      if (escalatedThisTurn) {
        if (terminalFailureReached) {
          break;
        }
        continue;
      }

      // Poisoned-history fix: if EVERY tool call in this turn produced a
      // validation error, revert history and inject a single correction note.
      // Without this, the model sees its own malformed tool calls + error
      // results in context and biases sampling toward more malformed output.
      if (__validationErrors.length > 0 && __validationErrors.length === message.tool_calls.length) {
        conversationHistory.length = __preTurnHistoryLen;
        conversationHistory.push({
          role: 'user',
          content: '[SYSTEM] Your previous response contained ONLY invalid tool-call arguments:\n' +
                   __validationErrors.map(e => '  - ' + e).join('\n') +
                   '\n\nRe-read the tool schemas and try again with valid arguments.',
        });
        if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', 'all tool calls invalid — retrying with clean history');
        else console.log(chalk.yellow('  ⚠ All tool calls invalidated — retrying with clean history'));
      }

      // Continue the loop — model may want to call more tools or fix errors
      continue;
    }

    // No tool calls — model is responding with text
    // Counter guard: if this is a coding/editing task and no tools were called,
    // the model may be prematurely answering instead of acting
    if (toolCallsThisTurn === 0 && (currentTaskType === 'coding' || currentTaskType === 'editing' || currentTaskType === 'backend')) {
      if (message.content && !message.content.includes('?') && message.content.length < 200) {
        // Model gave a short non-question response without using tools — push it to act
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You responded without using any tools. This task requires file operations. Please use the appropriate tools (read_file, write_file, patch, etc.) to complete the task. Do not just describe what you would do — actually do it.' });
        continue;
      }
    }

    // Greeting guard: detect when model outputs a greeting after tool failures (lost context)
    if (toolCallsThisTurn > 0 && message.content) {
      const greetingSignal = earlyStop.checkGreeting(message.content, toolCallsThisTurn > 0);
      if (greetingSignal && conversationHistory.some(m => m.role === 'user' && !m.content.startsWith('['))) {
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: greetingSignal.injection });
        continue;
      }
    }

    // Post-decompose give-up detection: if model responds with vague text after failures, notify user
    if (toolCallsThisTurn > 0 && message.content) {
      const lc = message.content.toLowerCase();
      const gaveUp = lc.includes('output is truncated') || lc.includes('let me try') || lc.includes('let me run') || (lc.length < 100 && !lc.includes('?') && toolCallsThisTurn > 3);
      const hadDecompose = conversationHistory.some(m => m.content && m.content.includes('[DECOMPOSE]'));
      if (gaveUp && hadDecompose && escalationEngine && escalationEngine.canEscalate()) {
        // Model is stuck after decompose — offer escalation
        if (_fullscreenRef) {
          _fullscreenRef.addTool('escalation', 'err', 'Model stuck after decompose. Attempting escalation...');
        }
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You appear stuck. The decompose strategy did not work. Take a completely different approach or clearly explain what is blocking you and what you need from the user to proceed.' });
        continue;
      }
    }

    let finalContent = '';
    // Stream the final response for better UX
    if (message.content) {
      // Contract done-guard: if a contract is active and the model claims
      // completion while assertions are still pending/failed, inject a
      // [CONTRACT-GUARD] system message and continue the loop instead of
      // pushing the wrap-up text. See src/session/contract_guard.js.
      try {
        const { checkDoneGuard } = require('../src/session/contract_guard');
        const guard = checkDoneGuard(message.content, process.cwd());
        if (guard) {
          conversationHistory.push({ role: 'assistant', content: message.content });
          conversationHistory.push({ role: 'user', content: guard.injection });
          if (_fullscreenRef) _fullscreenRef.addTool('contract', 'warn', `${guard.blockers.length} blockers`);
          else console.log(`  \x1b[33m⚠ contract guard: ${guard.blockers.length} unresolved assertion${guard.blockers.length === 1 ? '' : 's'}\x1b[0m`);
          continue;
        }
      } catch {}

      conversationHistory.push({ role: 'assistant', content: message.content });
      finalContent = message.content;

      // Reviewer agent (Feature #18): async critique of the response when files
      // were edited this turn. Non-blocking — fires after history push, injects
      // a note only if a real issue is found. Disable with SMALLCODE_REVIEWER=false.
      if (_editedFilesThisTurn.length > 0 && message.content.length > 50) {
        try {
          const { reviewResponse, formatReviewerInjection, getReviewerConfig } = require('../src/model/reviewer');
          if (getReviewerConfig(config).enabled) {
            _reviewerPromise = reviewResponse(userMessage, message.content, _editedFilesThisTurn, config)
              .then(reviewResult => {
                const injection = formatReviewerInjection(reviewResult);
                if (injection) {
                  conversationHistory.push({ role: 'user', content: injection });
                  if (_fullscreenRef) _fullscreenRef.addTool('reviewer', 'err', reviewResult.issues[0]?.slice(0, 80) || 'issues found');
                  else console.log(`  \x1b[33m⚠ reviewer: ${reviewResult.issues[0]?.slice(0, 100) || 'issues found'}\x1b[0m`);
                }
              })
              .catch(() => {});
          }
        } catch {}
      }

      // Plan extraction from a tool-less response (model planned without tools)
      try {
        if (_planTracker && _planTracker.needsPlan()) {
          // MarrowScript Feature #3: async LLM extractor with regex fallback
          if (await _planTracker.ingestResponseAsync(message.content)) {
            if (_fullscreenRef) _fullscreenRef.addTool('plan', 'ok', `${_planTracker.plan.length} steps`);
            // Remove the one-shot instruction from history (same as tool-call path)
            if (_planInstructionIdx >= 0 && _planInstructionIdx < conversationHistory.length) {
              const msg = conversationHistory[_planInstructionIdx];
              if (msg && msg.role === 'system' && typeof msg.content === 'string' &&
                  msg.content.includes('numbered plan')) {
                conversationHistory.splice(_planInstructionIdx, 1);
              }
              _planInstructionIdx = -1;
            }

            // Feature 4 + 3: path validation + dependency graph (same as tool-call path)
            try {
              const { validatePlanPaths, buildDependencyGraph, toParallelBatches, formatBatchSummary } = require('../src/session/dependency_graph');
              const { missing } = validatePlanPaths(_planTracker.plan, process.cwd());
              if (missing.length > 0) {
                const warnMsg = `[PATH-VALIDATION] Plan references files that don't exist on disk: ${missing.join(', ')}. ` +
                  `Use find_files or bash to locate the correct paths before proceeding.`;
                conversationHistory.push({ role: 'system', content: warnMsg });
                if (_fullscreenRef) _fullscreenRef.addTool('warning', 'warn', `missing paths: ${missing.join(', ')}`);
              }
              const graph = buildDependencyGraph(_planTracker.plan, process.cwd());
              const batches = toParallelBatches(graph, _planTracker.plan.length);
              _planTracker._executionBatches = batches;
              if (_fullscreenRef && batches.length > 0) {
                _fullscreenRef.addTool('plan', 'ok', formatBatchSummary(batches));
              }
            } catch {}
          }
        }
      } catch {}

      // Detect "step N done" markers so the plan tracker advances.
      // Matches: "step 1 done", "step 1: done", "Step 1. complete", "step1 finished".
      try {
        if (_planTracker && _planTracker.plan) {
          const stepDone = (message.content || '').match(/\bstep\s*(\d{1,2})[\s:.\-]+(?:done|complete|completed|finished|✓)\b/gi);
          if (stepDone) {
            for (const m of stepDone) {
              const n = parseInt(m.match(/\d+/)[0], 10);
              if (n >= 1 && n <= _planTracker.plan.length) {
                _planTracker.completeStep(n - 1);
              }
            }
          }
        }
      } catch {}
      // Render with markdown highlighting
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    } else if (toolCallsThisTurn === 0 && (!message.tool_calls || message.tool_calls.length === 0)) {
      // No content AND no tool calls AND no tools were called this turn — try streaming
      const finalStart = Date.now();
      const streamedContent = await streamFinalResponse(config, conversationHistory);
      const finalDuration = Date.now() - finalStart;
      if (streamedContent) {
        conversationHistory.push({ role: 'assistant', content: streamedContent });
        finalContent = streamedContent;
      }
      if (currentLedgerRunId) {
        try {
          const { getLedger } = require('../src/governor/run_ledger');
          getLedger().recordStep({
            runId: currentLedgerRunId,
            stepIndex: loopStepIndex++,
            stepType: 'model_response',
            name: config.model.name,
            durationMs: finalDuration,
            success: !!streamedContent,
            summary: streamedContent ? streamedContent.slice(0, 100) : 'Final response summary',
          });
        } catch (e) {}
      }
    }

    if (toolCallsThisTurn === 0 && finalContent.trim().length < 10) {
      updateFailureState(failureState, { type: 'no_progress' });
      const escalated = triggerAgentEscalation('no_progress');
      if (escalated) {
        if (escalated === 'terminal') {
          terminalFailureReached = true;
          break;
        }
        continue;
      }
    }

    // If tools were called but model returned empty content, that's fine — task is done.
    break;
  }

  if (toolCallsThisTurn >= MAX_TOOL_CALLS) {
    console.log(chalk.yellow('\n  ⚠ Reached tool call limit'));
  }

  if (toolCallsThisTurn > 0) {
    console.log(tui.turnSummary(toolCallsThisTurn));

    // Auto git commit if files were changed and we're in a git repo
    if (config.git?.auto_commit === true || process.env.SMALLCODE_AUTO_COMMIT === 'true') {
      try {
        const { execSync, execFileSync } = require('child_process');
        const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd(), timeout: 5000 });
        if (status.trim()) {
          // MarrowScript Feature #2: use compiled commit_message prompt instead of
          // simple string truncation. Falls back to truncation if prompt unavailable.
          const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user' && !m.content.startsWith('['));
          const task = lastUser ? lastUser.content : 'auto-commit';
          let commitMsg;
          try {
            const { generateCommitMessage } = require('./features_adapter');
            commitMsg = await generateCommitMessage(task, _editedFilesThisTurn);
          } catch {
            commitMsg = `smallcode: ${task.slice(0, 50).replace(/[\n\r"'`$\\]/g, ' ').trim()}`;
          }
          execFileSync('git', ['add', '-A'], { cwd: process.cwd(), timeout: 5000 });
          execFileSync('git', ['commit', '-m', commitMsg], { encoding: 'utf-8', cwd: process.cwd(), timeout: 10000 });
          if (_fullscreenRef) {
            _fullscreenRef.addTool('git', 'ok', `committed: ${commitMsg.slice(0, 60)}`);
          } else {
            console.log(chalk.green(`  ✓ git commit: ${commitMsg.slice(0, 60)}`));
          }
        }
      } catch {
        // Not a git repo or commit failed — silently skip
      }
    }
  }

  // Stop trace recording for this turn — and convert the trace into a
  // searchable evidence memory so future tasks can learn from what worked
  // and what failed. Stored as type:'context' tag:'evidence' in the existing
  // memory MCP module so it doesn't hog the live system prompt.
  const finishedTrace = traceRecorder.stop();

  // Clean up planner injection (Feature #15) — remove the chain planner's
  // system message from history so it doesn't pollute future turns.
  if (_plannerInjected) {
    const idx = conversationHistory.findIndex(m =>
      m.role === 'system' && typeof m.content === 'string' &&
      m.content.includes('PRE-ANALYZED PLAN'));
    if (idx >= 0) conversationHistory.splice(idx, 1);
  }

  // Await reviewer result (Feature #18) — give it up to 5 extra seconds
  // before exiting so non-interactive runs can still receive critique injection.
  if (typeof _reviewerPromise !== 'undefined' && _reviewerPromise) {
    try {
      await Promise.race([
        _reviewerPromise,
        new Promise(r => setTimeout(r, 5000)),
      ]);
    } catch {}
  }
  try {
    if (finishedTrace) {
      const { recordEvidence } = require('../src/memory/evidence');
      recordEvidence(memoryStore, finishedTrace, { taskType: currentTaskType });
    }
  } catch {} // never fail the agent loop on evidence-storage errors

  // Commit (discard) the snapshot checkpoint — clean run, no rollback needed.
  // If a hard failure earlier in the loop wanted to roll back, it would have
  // called rollback() before reaching here; commit() is a no-op in that case.
  try {
    const { getSnapshotManager } = require('../src/session/snapshot');
    getSnapshotManager().commit();
  } catch {}
}

// ─── Validation for Improvement Loop ────────────────────────────────────────

// LSP client instance (lazy-initialized on first validation)
let _lspClient = null;
let _lspAttempted = false;

const _lspServer = require('../src/api/lsp_server');

async function initLSP() {
  const client = await _lspServer.initLSP({
    fullscreenRef: typeof _fullscreenRef !== 'undefined' ? _fullscreenRef : null
  });
  _lspClient = _lspServer.getLspClient();
  return client;
}

// runValidation: delegate to the hardened version in model_client.js
// which uses execFileSync with arg arrays (no shell injection via filePath).
function runValidation(filePath) {
  return _toolExecution.runValidation(filePath);
}

// Build a compact system prompt — only includes sections relevant to the task type.
// When SMALLCODE_CACHE_SPLIT=true (Feature #14), this returns ONLY the static portion
// (identity, OS, bootstrap, rules) so it's cache-friendly across turns. Dynamic content
// (memory, knowledge, plan, test runner) is moved into a [CONTEXT] block prepended to
// the latest user message via buildDynamicContext().
//
// SMALLCODE_CACHE_SPLIT defaults to true. This prevents llama.cpp KV-cache
const _systemPrompt = require('../src/api/system_prompt');

function _getContextOptions() {
  return {
    testRunnerDetector: typeof _testRunnerDetector !== 'undefined' ? _testRunnerDetector : null,
    planTracker: typeof _planTracker !== 'undefined' ? _planTracker : null,
    knowledgeLoader: typeof _knowledgeLoader !== 'undefined' ? _knowledgeLoader : null,
    memoryStore,
    skillManager: typeof skillManager !== 'undefined' ? skillManager : null,
    pluginLoader,
    config,
    currentTaskType,
    currentLedgerRunId,
    currentAgentContext,
    _bootstrapDetector: typeof _bootstrapDetector !== 'undefined' ? _bootstrapDetector : null
  };
}

const _modelComms = require('../src/api/model_comms');

function _getModelCommsOptions() {
  return {
    currentTaskType: typeof currentTaskType !== 'undefined' ? currentTaskType : null,
    currentToolCategory: typeof currentToolCategory !== 'undefined' ? currentToolCategory : null,
    buildCompactSystemPrompt: (taskType, messages) => _systemPrompt.buildCompactSystemPrompt(taskType, messages, config, _getContextOptions()),
    buildDynamicContext: (messages) => _systemPrompt.buildDynamicContext(messages, _getContextOptions()),
    getAllTools,
    buildChatRequestBody,
    pluginLoader: typeof pluginLoader !== 'undefined' ? pluginLoader : null,
    tokenTracker: typeof tokenTracker !== 'undefined' ? tokenTracker : null,
    tokenMonitor: typeof tokenMonitor !== 'undefined' ? tokenMonitor : null,
    traceRecorder: typeof traceRecorder !== 'undefined' ? traceRecorder : null,
    chargeBudget: typeof chargeBudget !== 'undefined' ? chargeBudget : null,
    sessionStore: typeof sessionStore !== 'undefined' ? sessionStore : null,
    conversationHistory: typeof conversationHistory !== 'undefined' ? conversationHistory : null,
    logEvent,
    EVENT_TYPES,
    fullscreenRef: typeof _fullscreenRef !== 'undefined' ? _fullscreenRef : null,
    improvementAttempts: typeof improvementAttempts !== 'undefined' ? improvementAttempts : {},
    earlyStop: typeof earlyStop !== 'undefined' ? earlyStop : null,
    agentContext: typeof currentAgentContext !== 'undefined' ? currentAgentContext : null,
  };
}

// Make a chat completion request (non-streaming for tool use, streaming for final response)
async function chatCompletion(config, messages) {
  return _modelComms.chatCompletion(config, messages, _getModelCommsOptions());
}

// Stream a final text response (no tools, just text output)
async function streamFinalResponse(config, messages) {
  return _modelComms.streamFinalResponse(config, messages, _getModelCommsOptions());
}

// Streaming version for when no tools are needed (direct responses)
async function sendToModel(message, config) {
  return _modelComms.sendToModel(message, config, _getModelCommsOptions());
}

// ─── Non-Interactive Mode ────────────────────────────────────────────────────

async function runNonInteractive(config, prompt) {
  if (!prompt) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString().trim();
  }

  if (!prompt) {
    console.error('No prompt provided.');
    process.exit(1);
  }

  await runAgentLoop(prompt, config);

  // Explicit cleanup so the process exits cleanly. The persistent shell holds
  // a child cmd.exe with open stdio pipes that would otherwise keep the
  // Node event loop alive even after the agent loop returns.
  try {
    const { resetShell } = require('../src/tools/shell_session');
    resetShell();
  } catch {}
  try {
    const { resetReadTracker } = require('../src/tools/read_tracker');
    resetReadTracker();
  } catch {}
  try {
    const { resetFileStateTracker } = require('../src/session/file_state');
    resetFileStateTracker();
  } catch {}
  try {
    const { resetDedup, resetIdempotentWriteSet } = require('../src/tools/dedup');
    resetDedup();
    resetIdempotentWriteSet();
  } catch {}
  try {
    const { resetSnapshotManager } = require('../src/session/snapshot');
    resetSnapshotManager();
  } catch {}
  try {
    const { resetTrustDecay } = require('../src/tools/trust_decay');
    resetTrustDecay();
  } catch {}
  killMCP();
  if (_lspClient) { try { _lspClient.stop(); } catch {} }
  logEvent(EVENT_TYPES.SESSION_END, { reason: 'complete', mode: 'non-interactive' });
  // Force exit after a short tick to let any pending log writes flush.
  setTimeout(() => process.exit(0), 100).unref();
}

// ─── MCP Server Mode ─────────────────────────────────────────────────────────

const _mcpServer = require('../src/api/mcp_server');

function runMCP() {
  _mcpServer.runMCP();
}

async function handleMCPRequest(request) {
  return _mcpServer.handleMCPRequest(request);
}

async function handleMCPToolCall(id, params) {
  return _mcpServer.handleMCPToolCall(id, params, {
    currentTaskType: typeof currentTaskType !== 'undefined' ? currentTaskType : null,
    currentLedgerRunId: typeof currentLedgerRunId !== 'undefined' ? currentLedgerRunId : null,
    memoryStore
  });
}

// ─── Minimal TUI (no model — plugin commands only) ──────────────────────────

// startMinimalTUI is extracted to src/runtime/tui_manager.js

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { startMinimalTUI, runTUI } = require('../src/runtime/tui_manager');
  config = loadConfig();

  // Initialize plugins early so they can handle setup (e.g. /provider wizard)
  pluginLoader = new PluginLoader(process.cwd()).loadAll();
  await pluginLoader.runInit({ config, cwd: process.cwd() });
  skillManager = new SkillManager(process.cwd());

  const { handleMissingModel, handleProviderCommand, runEvalMode, initializeSession } = require('../src/cli/bootstrap_helpers');
  if (await handleMissingModel(config, positional, () => startMinimalTUI(logEvent, EVENT_TYPES, config))) return;

  // Initialize escalation engine
  escalationEngine = new EscalationEngine(config.escalation || {});

  // Detect model profile (drives routing mode, tool format, context budget)
  const modelProfile = getProfile(config.model.name, config.context.detected_window);
  if (modelProfile.matched_key) {
    // Apply profile-detected context window if not already set
    if (!config.context.detected_window && modelProfile.context_length) {
      config.context.detected_window = modelProfile.context_length;
    }
  }

  // Initialize plugins and skills
  pluginLoader = new PluginLoader(process.cwd()).loadAll();
  await pluginLoader.runInit({ config, cwd: process.cwd() });

  // Run plugin shutdown handlers on exit
  process.on('beforeExit', () => {
    if (pluginLoader) pluginLoader.runShutdown({ config, cwd: process.cwd() }).catch(() => {});
  });

  skillManager = new SkillManager(process.cwd());

  // Initialize MCP client (connect to external MCP servers)
  let mcpClient = null;
  const mcpClientInstance = new MCPClient(process.cwd());
  if (mcpClientInstance.loadConfig() > 0) {
    mcpClient = mcpClientInstance;
    // Connect asynchronously — don't block boot
    mcpClient.connectAll().then(toolCount => {
      if (toolCount > 0 && _fullscreenRef) {
        _fullscreenRef.addTool('mcp-client', 'ok', `${toolCount} external tools from ${mcpClient.servers.size} servers`);
      }
    }).catch(() => {});
  }

  // Initialize session + token tracking
  sessionStore = new SessionStore(process.cwd());
  tokenTracker = new TokenTracker();

  journal = initializeSession(flags, config, sessionStore, conversationHistory, improvementAttempts, logEvent, EVENT_TYPES, process.cwd());

  if (!flags.mcp) {
    try {
      const { getActiveWorkspace, getWorkspaceSummary } = require('../src/governor/project_workspace');
      const activeId = getActiveWorkspace();
      if (activeId) {
        const summary = getWorkspaceSummary(activeId);
        console.log(`  ⚡ Active workspace: ${activeId} (${summary.rootPath || 'No rootPath set'})`);
      }
    } catch (e) {}
  }

  if (flags.mcp) {
    runMCP();
    return;
  }

  if (flags.init) {
    require('./init');
    return;
  }

  // Eval mode: run prompt evaluation suites
  if (flags.eval) {
    await runEvalMode(flags, config, chatCompletion);
  }

  if (flags.acp) {
    const { ACPAdapter } = require('../src/adapters/acp');
    const adapter = new ACPAdapter(runAgentLoop, config);
    adapter.start();
    return;
  }

  // Handle /provider even when model IS configured (must come before positional prompt)
  if (await handleProviderCommand(config, positional)) return;

  if (flags.nonInteractive || flags.prompt || positional.length > 0) {
    const prompt = flags.prompt || positional.join(' ');
    await runNonInteractive(config, prompt);
    return;
  }

  await runTUI({
    config,
    flags,
    conversationHistory,
    improvementAttempts,
    runAgentLoop,
    runValidation,
    MAX_IMPROVE_ITERATIONS,
    memoryStore,
    escalationEngine,
    tokenMonitor,
    tokenTracker,
    sessionStore,
    killMCP,
    logEvent,
    EVENT_TYPES,
    tui,
    checkOllama,
    initCodeGraph,
    _lspClient,
    setFullscreenRef: (screen) => _fullscreenRef = screen
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    logEvent(EVENT_TYPES.ERROR, {
      phase: 'main',
      message: err.message,
      stackSummary: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
    });
    logEvent(EVENT_TYPES.SESSION_END, { reason: 'fatal_error', mode: 'cli' });
    process.exit(1);
  });
}

module.exports = {
  buildChatRequestBody,
  getAllTools,
};
