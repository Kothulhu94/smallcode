// SmallCode — Model Client
// Handles all communication with the LLM endpoint:
// - chatCompletion (non-streaming, for tool use)
// - streamFinalResponse (streaming summary after tool turns)
// - sendToModel (streaming direct response)
// - runValidation (file validation for improvement loop)

const path = require('path');
const fs = require('fs');
const { buildAuthHeaders, getModelTarget, withModelTarget } = require('./config');
const { redactString } = require('../src/security/sanitize');

/**
 * Make a chat completion request (non-streaming, for tool use).
 * @param {object} ctx - Shared context { config, conversationHistory, memoryStore, skillManager, pluginLoader, currentTaskType, tokenTracker, sessionStore, getAllTools, _fullscreenRef }
 */
async function chatCompletion(ctx) {
  const { config, conversationHistory, tokenTracker, sessionStore } = ctx;
  const target = config.activeModelTarget || getModelTarget(config, 'default');
  const requestConfig = withModelTarget(config, target);
  const baseUrl = target.baseUrl;

  const systemMsg = {
    role: 'system',
    content: buildSystemPrompt(ctx),
  };

  try {
    const { extractImages, formatImagesForAPI } = require('../src/session/images');
    const { probeVisionSupport } = require('../src/vision/vision_capability_probe');
    const probe = probeVisionSupport({ ...config, activeModelTarget: target });

    let firstImagePath = null;
    let hasImages = false;

    const processedMessages = conversationHistory.map(msg => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
      const images = extractImages(msg.content, process.cwd());
      if (images.length > 0) {
        hasImages = true;
        if (!firstImagePath) firstImagePath = images[0].path;
      }
      if (images.length === 0 || !probe.supported) return msg;
      return { ...msg, content: [{ type: 'text', text: msg.content }, ...formatImagesForAPI(images)] };
    });

    if (hasImages && !probe.supported) {
      return {
        error: "Vision input is not supported by the active model endpoint",
        imagePath: firstImagePath,
        hint: "Screenshot was captured/stored, but the active model endpoint cannot analyze images."
      };
    }

    const _tools = ctx.getAllTools(config);
    const body = {
      model: target.model,
      messages: [systemMsg, ...processedMessages],
      temperature: 0.1,
      max_tokens: 4096,
    };
    // Only include tools when there are tools to send — some endpoints (OpenWebUI)
    // error on an empty tools array rather than treating it as "no tools".
    if (_tools && _tools.length > 0) {
      body.tools = _tools;
    }

    const { getActiveAgentContext, getAgent } = require('../src/governor/agent_registry');
    let agentCtx = null;
    if (ctx.activeAgent) {
      if (typeof ctx.activeAgent === 'string') {
        agentCtx = getAgent(ctx.activeAgent);
      } else if (typeof ctx.activeAgent === 'object') {
        agentCtx = ctx.activeAgent;
      }
    }
    if (!agentCtx && ctx.currentTaskType) {
      agentCtx = getActiveAgentContext(ctx.currentTaskType);
    }

    if (agentCtx && (agentCtx.thinkingEnabled === true || agentCtx.agent?.thinkingEnabled === true)) {
      body.chat_template_kwargs = body.chat_template_kwargs || {};
      body.chat_template_kwargs.thinking_enabled = true;
    }

    const headers = buildAuthHeaders(requestConfig);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      if (response.status >= 400 && response.status < 500) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retry = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
          if (retry.ok) return await retry.json();
        } catch {}
      }
      // Redact the error response — providers sometimes echo the request
      // back, including the Authorization header value, when responding
      // with 401/403. Never print raw provider errors verbatim.
      console.log(`  \x1b[31m✗ API error ${response.status}: ${redactString(err.slice(0, 200))}\x1b[0m`);
      if (hasImages) {
        return {
          error: "Vision input is not supported by the active model endpoint",
          imagePath: firstImagePath,
          hint: `The endpoint rejected the image payload. Status: ${response.status}. Error: ${err.slice(0, 200)}`
        };
      }
      return null;
    }

    const data = await response.json();

    if (tokenTracker && data?.usage) {
      tokenTracker.record(data, target.model);
    }
    if (sessionStore) {
      sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
      sessionStore.autoTitle(conversationHistory);
    }

    return data;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${err.message}\x1b[0m`);
    // Find if there were images in conversationHistory
    const { extractImages } = require('../src/session/images');
    let hasImages = false;
    let firstImagePath = null;
    for (const msg of conversationHistory) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const images = extractImages(msg.content, process.cwd());
        if (images.length > 0) {
          hasImages = true;
          firstImagePath = images[0].path;
          break;
        }
      }
    }
    if (hasImages) {
      return {
        error: "Vision input is not supported by the active model endpoint",
        imagePath: firstImagePath,
        hint: `Network/API connection failed: ${err.message}`
      };
    }
    return null;
  }
}

/**
 * Stream a final text response (no tools, just summarize).
 */
async function streamFinalResponse(ctx) {
  const { config, earlyStop, _fullscreenRef } = ctx;
  const target = config.activeModelTarget || getModelTarget(config, 'default');
  const requestConfig = withModelTarget(config, target);
  const baseUrl = target.baseUrl;

  const systemMsg = { role: 'system', content: 'You are SmallCode, a coding assistant. Summarize what you just did in 1-2 sentences. Be concise.' };

  try {
    const headers = buildAuthHeaders(requestConfig);
    const messages = ctx.conversationHistory;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: target.model,
        messages: [systemMsg, ...messages.slice(-6)],
        stream: true,
        temperature: 0.1,
        max_tokens: 256,
      }),
    });

    if (!response.ok) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    if (_fullscreenRef) _fullscreenRef.setStreaming(true);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
          else console.log('');
          return fullContent;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (_fullscreenRef) _fullscreenRef.streamToken(delta.content);
            else process.stdout.write(delta.content);
            fullContent += delta.content;

            if (earlyStop) {
              const stopSignal = earlyStop.checkRepetition(fullContent);
              if (stopSignal) {
                if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
                else console.log(`\n  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
                return fullContent;
              }
            }
          }
        } catch {}
      }
    }
    if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
    else console.log('');
    return fullContent;
  } catch {
    return null;
  }
}

/**
 * Validate a file (compile check, syntax check, etc.).
 *
 * Note: filePath comes from the agent (which is itself prompted by the
 * model). It is interpolated into shell commands below via execFileSync
 * with an args array — never via string interpolation — so a model that
 * tries to inject a quoted command tail can't.
 */
function runValidation(filePath) {
  const { execFileSync, execSync } = require('child_process');
  const ext = path.extname(filePath);
  const cwd = process.cwd();

  // Reject obviously hostile filePaths early.
  if (typeof filePath !== 'string' || filePath.indexOf('\u0000') !== -1) {
    return { passed: false, errors: ['invalid filePath'] };
  }

  // Helper: run an external program with args and uniform error parsing.
  const runArgs = (cmd, args, parseErrors) => {
    try {
      execFileSync(cmd, args, { encoding: 'utf-8', timeout: 20000, cwd });
      return { passed: true, errors: [] };
    } catch (e) {
      const output = (e.stdout || '') + (e.stderr || '');
      const errors = parseErrors(output).filter(Boolean);
      if (errors.length === 0) return { passed: true, errors: [] };
      return { passed: false, errors };
    }
  };

  if ((ext === '.ts' || ext === '.tsx') && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return runArgs('npx', ['tsc', '--noEmit', '--pretty', 'false'],
      (output) => output.split('\n').filter(l => l.includes(filePath) && l.includes('error')).slice(0, 5));
  }
  if (ext === '.py') {
    return runArgs('python', ['-m', 'py_compile', filePath],
      (output) => output.trim() ? [output.trim()] : []);
  }
  if (ext === '.rs' && fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return runArgs('cargo', ['check', '--message-format', 'short'],
      (output) => output.split('\n').filter(l => l.startsWith('error')).slice(0, 5));
  }
  if (ext === '.go' && fs.existsSync(path.join(cwd, 'go.mod'))) {
    return runArgs('go', ['build', './...'],
      (output) => output.split('\n').filter(l => l.includes(filePath)).slice(0, 5));
  }
  if (ext === '.js' || ext === '.mjs') {
    return runArgs('node', ['--check', filePath],
      (output) => output.trim() ? [output.trim()] : []);
  }
  if (ext === '.json') {
    try { JSON.parse(fs.readFileSync(path.resolve(cwd, filePath), 'utf-8')); return { passed: true, errors: [] }; }
    catch (e) { return { passed: false, errors: [e.message] }; }
  }
  if (ext === '.bone') {
    const compilerPaths = [
      path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'),
      path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js'),
    ];
    let compiler = null;
    for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
    if (!compiler) return null;
    try { execFileSync('node', [compiler, '--version'], { encoding: 'utf-8', timeout: 5000, cwd }); } catch { return null; }
    return runArgs('node', [compiler, 'check', filePath],
      (output) => output.split('\n').filter(l => l.includes('error')).slice(0, 5));
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx) {
  const { config, conversationHistory, currentTaskType } = ctx;
  const memCtx = getMemoryContext(ctx);
  const skillCtx = getSkillContext(ctx);
  const pluginCtx = getPluginPrompts(ctx);

  const { getActiveAgentContext } = require('../src/governor/agent_registry');
  const agentCtx = ctx.activeAgent || getActiveAgentContext(currentTaskType);
  let agentIdentityLine = '';
  if (agentCtx) {
    agentIdentityLine = `\n\n[ACTIVE_AGENT]\nid: ${agentCtx.agentId}\nname: ${agentCtx.name}\nrole: ${agentCtx.description}\n[/ACTIVE_AGENT]`;
  }

  let workspaceIdentityLine = '';
  try {
    const { getActiveWorkspace, loadWorkspaceManifest } = require('../src/governor/project_workspace');
    const activeId = getActiveWorkspace();
    if (activeId) {
      const manifest = loadWorkspaceManifest(activeId);
      workspaceIdentityLine = `\n\n[ACTIVE_WORKSPACE]\nid: ${manifest.projectId}\nname: ${manifest.name}\ngoal: ${manifest.activeGoal || 'No active goal set.'}\n[/ACTIVE_WORKSPACE]`;
    }
  } catch (e) {}

  let prompt = `You are SmallCode, a coding assistant that operates in the user's project directory.${agentIdentityLine}${workspaceIdentityLine}

You have tools to read, write, and edit files, run shell commands, and search code.
You also have project memory and compound tools that do multiple operations in one call.
You have a CODE GRAPH indexed for this project — use it for understanding questions.

IMPORTANT — Code Graph (use these FIRST for understanding/analysis questions):
- list_projects: Lists ALL projects in the workspace with stats. Use FIRST when asked "what projects are here".
- graph_search: Search for a specific symbol/function/class in the graph.
- explain_symbol: Get full explanation of a function/class.
- memory_load: Load relevant project memory.

IMPORTANT — Environment:
- OS: ${process.platform === 'win32' ? 'Windows (cmd.exe shell)' : process.platform === 'darwin' ? 'macOS (zsh)' : 'Linux (bash)'}
${process.platform === 'win32' ? '- Use "dir" not "ls", "type" not "cat", "del" not "rm"\n- Do NOT use bash-specific commands (touch, export, chmod)' : ''}

Rules:
- PREFER compound tools to reduce back-and-forth.
- Use "patch" for edits. Do NOT rewrite whole files.
- Be concise — show what you did, not lengthy explanations.
- If a tool fails, explain what went wrong. Do NOT output a greeting.
- Create files with write_file directly. Do NOT run mkdir first.`;

  if (currentTaskType === 'backend') {
    prompt += `\n\nBONESCRIPT MODE — For Node.js/TypeScript backends, use BoneScript.`;
  }

  prompt += `\nWorking directory: ${process.cwd()}`;
  prompt += memCtx + skillCtx + pluginCtx;

  if (config && config.activeEscalationSummary) {
    prompt += '\n\n' + config.activeEscalationSummary;
  }

  if (config && config.activeHandoffPrompt) {
    prompt += '\n\n' + config.activeHandoffPrompt;
  }

  return prompt;
}

function getMemoryContext(ctx) {
  try {
    const { memoryStore, conversationHistory, currentTaskType } = ctx;
    if (!memoryStore || !memoryStore.loadForTask) return '';
    const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const raw = memoryStore.loadForTask(lastUser.content, 800, { taskType: currentTaskType });
    const objects = Array.isArray(raw) ? raw : (raw?.objects || []);
    if (objects.length === 0) return '';
    const { renderMemoryForContext } = require('./memory');
    return '\n\nRelevant project memory:\n' + objects.map(o => renderMemoryForContext(o).trim()).join('\n');
  } catch { return ''; }
}

function getSkillContext(ctx) {
  if (!ctx.skillManager) return '';
  try {
    const lastUser = [...ctx.conversationHistory].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const skills = ctx.skillManager.getAutoSkills(lastUser.content);
    return ctx.skillManager.formatForPrompt(skills);
  } catch { return ''; }
}

function getPluginPrompts(ctx) {
  if (!ctx.pluginLoader) return '';
  try {
    const injection = ctx.pluginLoader.getPromptInjections(ctx.currentTaskType);
    return injection ? '\n\n' + injection : '';
  } catch { return ''; }
}

module.exports = { chatCompletion, streamFinalResponse, runValidation, buildSystemPrompt };
