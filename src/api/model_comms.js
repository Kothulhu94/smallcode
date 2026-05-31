const { getModelTarget, withModelTarget, buildAuthHeaders } = require('../../bin/config');
const { providerRegistry } = require('../compiled/providers/registry');
const { prepareVisionMessages, startSpinner, streamOpenAI, streamOllama } = require('./model_comms_helpers');

async function chatCompletion(config, messages, options = {}) {
  const {
    currentTaskType,
    currentToolCategory,
    buildCompactSystemPrompt,
    buildDynamicContext,
    getAllTools,
    buildChatRequestBody,
    pluginLoader,
    tokenTracker,
    tokenMonitor,
    traceRecorder,
    chargeBudget,
    sessionStore,
    conversationHistory,
    logEvent,
    EVENT_TYPES,
    fullscreenRef,
    improvementAttempts,
    agentContext,
  } = options;

  let target = config.activeModelTarget || getModelTarget(config, 'default');
  let requestConfig = withModelTarget(config, target);
  let baseUrl = target.baseUrl;
  
  const systemMsg = {
    role: 'system',
    content: buildCompactSystemPrompt(currentTaskType, messages),
  };

  try {
    function stripAnsiFromMsg(msg) {
      if (!msg || typeof msg.content !== 'string') return msg;
      return { ...msg, content: msg.content.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '') };
    }
    const processedMessages = messages.map(stripAnsiFromMsg);

    const dynamicCtx = buildDynamicContext(messages);
    if (dynamicCtx) {
      const lastIdx = processedMessages.reduce((last, m, i) => m.role === 'user' ? i : last, -1);
      if (lastIdx >= 0) {
        const lastMsg = processedMessages[lastIdx];
        if (typeof lastMsg.content === 'string') {
          processedMessages[lastIdx] = {
            ...lastMsg,
            content: dynamicCtx + lastMsg.content,
          };
        }
        else if (Array.isArray(lastMsg.content)) {
          const firstText = lastMsg.content.find(c => c.type === 'text');
          if (firstText) {
            processedMessages[lastIdx] = {
              ...lastMsg,
              content: [
                { type: 'text', text: dynamicCtx + firstText.text },
                ...lastMsg.content.filter(c => c !== firstText),
              ],
            };
          }
        }
      }
    }

    const { processedWithImages, hasImages, firstImagePath, probeSupported } = prepareVisionMessages({ ...config, activeModelTarget: target }, processedMessages);

    if (hasImages && !probeSupported) {
      return {
        error: "Vision input is not supported by the active model endpoint",
        imagePath: firstImagePath,
        hint: "Screenshot was captured/stored, but the active model endpoint cannot analyze images."
      };
    }

    const _tools = getAllTools(config, currentToolCategory);
    
    const attempts = Object.entries(improvementAttempts || {})
      .filter(([k, v]) => !k.startsWith('__') && typeof v === 'number' && v > 0)
      .reduce((acc, [, v]) => acc + v, 0);

    const { body, target: finalTarget, requestConfig: finalRequestConfig, baseUrl: finalBaseUrl } = buildChatRequestBody(
      [systemMsg, ...processedWithImages],
      _tools,
      config,
      {
        target,
        baseUrl,
        currentAttempt: attempts,
        agentContext,
      }
    );

    target = finalTarget;
    requestConfig = finalRequestConfig;
    baseUrl = finalBaseUrl;

    if (body.__toolsDisabledReason) {
      console.log(`  \x1b[33m⚠ Tools disabled: ${body.__toolsDisabledReason}\x1b[0m`);
    }

    const headers = buildAuthHeaders(requestConfig);

    const timeoutSecs = parseInt(process.env.SMALLCODE_MODEL_TIMEOUT) || config.model?.timeout || 300;
    const timeoutMs = timeoutSecs * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const _stopSpinner = startSpinner(fullscreenRef);

    if (pluginLoader) {
      await pluginLoader.runHooks('pre_request', {
        provider: config.model.provider,
        model: body.model || config.model.name,
        messages: processedMessages,
      });
    }

    const pluginProvider = providerRegistry.get(config.model.provider);
    if (pluginProvider) {
      _stopSpinner();
      try {
        const chatResp = await pluginProvider.chat({
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          maxOutput: body.max_tokens,
          tools: body.tools,
        }, controller.signal);
        clearTimeout(timeout);

        const data = {
          choices: [{
            message: {
              role: 'assistant',
              content: chatResp.content,
              tool_calls: chatResp.tool_calls || [],
            },
            finish_reason: chatResp.tool_calls?.length ? 'tool_calls' : 'stop',
          }],
          usage: chatResp.usage ? {
            prompt_tokens: chatResp.usage.promptTokens,
            completion_tokens: chatResp.usage.completionTokens,
            total_tokens: chatResp.usage.totalTokens,
          } : undefined,
        };

        if (tokenTracker && data.usage) {
          tokenTracker.record(data, config.model.name);
        }
        if (data.usage) {
          if (tokenMonitor) tokenMonitor.recordCall(data.usage.prompt_tokens, data.usage.completion_tokens);
          if (traceRecorder) traceRecorder.recordTokens(data.usage.prompt_tokens, data.usage.completion_tokens);
          if (chargeBudget) {
            try { chargeBudget('run_turn', { tokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0) }); } catch {}
          }
        }
        return data;
      } catch (pluginErr) {
        clearTimeout(timeout);
        const msg = pluginErr.message || 'Plugin provider failed';
        console.log(`  \x1b[31m✗ Plugin provider "${config.model.provider}": ${msg}\x1b[0m`);
        if (fullscreenRef) fullscreenRef.addTool('error', 'err', `${config.model.provider}: ${msg.slice(0, 80)}`);
        return null;
      }
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      _stopSpinner();
      if (hasImages) {
        return {
          error: "Vision input is not supported by the active model endpoint",
          imagePath: firstImagePath,
          hint: `Network/API connection failed: ${fetchErr.message}`
        };
      }
      if (fetchErr.name === 'AbortError' || fetchErr.message?.includes('abort')) {
        const msg = `Model timed out after ${timeoutSecs}s. The model is still processing or the endpoint is unresponsive.\n  Tip: increase timeout with SMALLCODE_MODEL_TIMEOUT=600 in your .env`;
        console.log(`  \x1b[33m⏱ ${msg}\x1b[0m`);
        if (fullscreenRef) fullscreenRef.addTool('timeout', 'err', `no response after ${timeoutSecs}s`);
      } else {
        const errMsg = fetchErr.message || 'Connection failed';
        const hint = errMsg.includes('ECONNREFUSED') ? ' — is LM Studio running?' :
                     errMsg.includes('ENOTFOUND')    ? ' — check SMALLCODE_BASE_URL' :
                     errMsg.includes('ECONNRESET')   ? ' — LM Studio may have crashed or restarted' :
                     '';
        console.log(`  \x1b[31m✗ Endpoint error: ${errMsg}${hint}\x1b[0m`);
        if (fullscreenRef) fullscreenRef.addTool('error', 'err', `${errMsg.slice(0, 80)}${hint}`);
      }
      if (pluginLoader) {
        await pluginLoader.runHooks('on_error', {
          provider: config.model.provider,
          model: body.model || config.model.name,
          error: fetchErr,
        }).catch(() => {});
      }
      return null;
    }
    clearTimeout(timeout);
    _stopSpinner();

    if (!response.ok) {
      const err = await response.text();
      if (response.status >= 400) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          if (retry.ok) return await retry.json();
        } catch {}
      }
      const errDetail = err.slice(0, 200);
      console.log(`  \x1b[31m✗ API error ${response.status}: ${errDetail}\x1b[0m`);
      if (fullscreenRef) fullscreenRef.addTool('error', 'err', `HTTP ${response.status}: ${errDetail.slice(0, 80)}`);
      
      try { const { getAdaptiveRouter } = require('../model/adaptive_router'); getAdaptiveRouter().recordCall(body.model || config.model.name, false); } catch {}
      
      if (hasImages) {
        return {
          error: "Vision input is not supported by the active model endpoint",
          imagePath: firstImagePath,
          hint: `The endpoint rejected the image payload. Status: ${response.status}. Error: ${errDetail}`
        };
      }
      return null;
    }

    const data = await response.json();

    if (pluginLoader) {
      await pluginLoader.runHooks('post_request', {
        provider: config.model.provider,
        model: body.model || config.model.name,
        response: data,
        usage: data?.usage || null,
      }).catch(() => {});
    }

    if (tokenTracker && data?.usage) {
      tokenTracker.record(data, body.model || config.model.name);
    }
    if (data?.usage) {
      if (tokenMonitor) tokenMonitor.recordCall(data.usage.prompt_tokens, data.usage.completion_tokens);
      if (traceRecorder) traceRecorder.recordTokens(data.usage.prompt_tokens, data.usage.completion_tokens);
      if (chargeBudget) {
        try { chargeBudget('run_turn', { tokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0) }); } catch {}
      }
    }

    try {
      const { getAdaptiveRouter } = require('../model/adaptive_router');
      getAdaptiveRouter().recordCall(body.model || config.model.name, true);
    } catch {}

    if (sessionStore && conversationHistory) {
      sessionStore.save(conversationHistory, {
        tokens: tokenTracker ? tokenTracker.stats() : undefined,
      });
      sessionStore.autoTitle(conversationHistory);
    }

    return data;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${err.message}\x1b[0m`);
    if (logEvent) {
      logEvent(EVENT_TYPES?.ERROR || 'error', {
        phase: 'chatCompletion',
        message: err.message,
        stackSummary: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
      });
    }
    if (typeof hasImages !== 'undefined' && hasImages) {
      return {
        error: "Vision input is not supported by the active model endpoint",
        imagePath: typeof firstImagePath !== 'undefined' ? firstImagePath : null,
        hint: `Network/API connection failed: ${err.message}`
      };
    }
    return null;
  }
}

async function streamFinalResponse(config, messages, options = {}) {
  const { fullscreenRef, earlyStop, logEvent, EVENT_TYPES } = options;
  const target = config.activeModelTarget || getModelTarget(config, 'default');
  const requestConfig = withModelTarget(config, target);
  const baseUrl = target.baseUrl;
  const systemMsg = {
    role: 'system',
    content: `You are SmallCode, a coding assistant. Summarize what you just did in 1-2 sentences. Be concise.`
  };

  try {
    const headers = buildAuthHeaders(requestConfig);

    const recent = messages.slice(-8);
    const safeMessages = [];
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      if (m.tool_calls) {
        const ids = m.tool_calls.map(tc => tc.id);
        const hasAll = ids.every(id => recent.slice(i + 1).some(r => r.role === 'tool' && r.tool_call_id === id));
        if (hasAll) safeMessages.push(m);
      } else if (m.role === 'tool') {
        const hasOwner = safeMessages.some(s => s.tool_calls && s.tool_calls.some(tc => tc.id === m.tool_call_id));
        if (hasOwner) safeMessages.push(m);
      } else {
        safeMessages.push(m);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); 

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: target.model,
        messages: [systemMsg, ...safeMessages.slice(-6)],
        stream: true,
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    if (fullscreenRef) fullscreenRef.setStreaming(true);

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
          if (fullscreenRef) { fullscreenRef.endStream(); fullscreenRef.setStreaming(false); }
          else console.log('');
          return fullContent;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (fullscreenRef) {
              fullscreenRef.streamToken(delta.content);
            } else {
              process.stdout.write(delta.content);
            }
            fullContent += delta.content;

            if (earlyStop) {
              const stopSignal = earlyStop.checkRepetition(fullContent);
              if (stopSignal) {
                if (fullscreenRef) { fullscreenRef.endStream(); fullscreenRef.setStreaming(false); }
                else console.log(`\n  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
                return fullContent;
              }
            }
          }
        } catch {}
      }
    }
    if (fullscreenRef) { fullscreenRef.endStream(); fullscreenRef.setStreaming(false); }
    else console.log('');
    return fullContent;
  } catch (err) {
    if (logEvent) {
      logEvent(EVENT_TYPES?.ERROR || 'error', {
        phase: 'streamFinalResponse',
        message: err.message,
        stackSummary: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
      });
    }
    return null;
  }
}

async function sendToModel(message, config, options = {}) {
  const { logEvent, EVENT_TYPES } = options;
  const target = config.activeModelTarget || getModelTarget(config, 'default');
  const requestConfig = withModelTarget(config, target);
  const baseUrl = target.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const systemPrompt = `You are SmallCode, a coding assistant. You help users by reading, editing, and creating code files.
Rules:
- Read files before editing them.
- Use search-and-replace for edits. Never rewrite entire files.
- Keep responses concise and focused.
- If a task is complex, break it into steps.`;

  if (target.provider === 'openai' || baseUrl.includes('/v1')) {
    const headers = buildAuthHeaders(requestConfig);
    return await streamOpenAI(baseUrl, target, systemPrompt, message, headers, options);
  }
  return await streamOllama(baseUrl, target, systemPrompt, message, options);
}

module.exports = {
  chatCompletion,
  streamFinalResponse,
  sendToModel
};
