'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChatRequestBody } = require('../src/api/request_builder');
const { getAgent, getActiveAgentContext } = require('../src/governor/agent_registry');

test('Agent Thinking - conductor, code_editor, qa_tester, architect have thinkingEnabled: true', () => {
  const conductor = getAgent('conductor');
  const code_editor = getAgent('code_editor');
  const qa_tester = getAgent('qa_tester');
  const architect = getAgent('architect');

  assert.equal(conductor.thinkingEnabled, true);
  assert.equal(code_editor.thinkingEnabled, true);
  assert.equal(qa_tester.thinkingEnabled, true);
  assert.equal(architect.thinkingEnabled, true);
});

test('Agent Thinking - other agents do not have thinkingEnabled set or true', () => {
  const repo_navigator = getAgent('repo_navigator');
  const researcher = getAgent('researcher');
  const memory_curator = getAgent('memory_curator');
  const visual_observer = getAgent('visual_observer');

  assert.notEqual(repo_navigator?.thinkingEnabled, true);
  assert.notEqual(researcher?.thinkingEnabled, true);
  assert.notEqual(memory_curator?.thinkingEnabled, true);
  assert.notEqual(visual_observer?.thinkingEnabled, true);
});

test('Agent Thinking - request builder injects thinking_enabled for enabled agents', () => {
  const conductor = getAgent('conductor');
  const config = {
    model: { provider: 'openai', name: 'gemma-4', baseUrl: 'http://localhost:5001/v1' },
    activeModelTarget: { model: 'gemma-4', baseUrl: 'http://localhost:5001/v1', provider: 'openai' }
  };

  // 1. Direct agent config object
  const { body: body1 } = buildChatRequestBody([], [], config, { agentContext: conductor });
  assert.equal(body1.chat_template_kwargs?.thinking_enabled, true);

  // 2. Wrapped agent context from getActiveAgentContext
  const conductorCtx = getActiveAgentContext('multi_step');
  const { body: body2 } = buildChatRequestBody([], [], config, { agentContext: conductorCtx });
  assert.equal(body2.chat_template_kwargs?.thinking_enabled, true);
});

test('Agent Thinking - request builder does not inject thinking_enabled for disabled agents', () => {
  const repo_navigator = getAgent('repo_navigator');
  const config = {
    model: { provider: 'openai', name: 'gemma-4', baseUrl: 'http://localhost:5001/v1' },
    activeModelTarget: { model: 'gemma-4', baseUrl: 'http://localhost:5001/v1', provider: 'openai' }
  };

  const { body: body1 } = buildChatRequestBody([], [], config, { agentContext: repo_navigator });
  assert.equal(body1.chat_template_kwargs?.thinking_enabled, undefined);

  const repoNavCtx = getActiveAgentContext('search');
  const { body: body2 } = buildChatRequestBody([], [], config, { agentContext: repoNavCtx });
  assert.equal(body2.chat_template_kwargs?.thinking_enabled, undefined);

  // Missing agent context
  const { body: body3 } = buildChatRequestBody([], [], config, {});
  assert.equal(body3.chat_template_kwargs?.thinking_enabled, undefined);
});

test('Agent Thinking - existing chat_template_kwargs keys are preserved', () => {
  const conductor = getAgent('conductor');
  
  // To test preservation, we simulate a reasoning model on local server that sets:
  // body.chat_template_kwargs.enable_thinking = true;
  // body.chat_template_kwargs.thinking_budget = 2000;
  // This config target is detected as LocalLlamaCpp + reasoningModel inside request_builder
  const configReasoning = {
    model: { provider: 'openai', name: 'qwen3-reasoning', baseUrl: 'http://localhost:1234/v1' },
    activeModelTarget: { model: 'qwen3-reasoning', baseUrl: 'http://localhost:1234/v1', provider: 'openai' }
  };
  
  const { body } = buildChatRequestBody([], [], configReasoning, {
    agentContext: conductor
  });
  
  // Assert both keys coexist in chat_template_kwargs
  assert.equal(body.chat_template_kwargs?.enable_thinking, true);
  assert.equal(body.chat_template_kwargs?.thinking_enabled, true);
});

test('Agent Thinking - model_client chatCompletion resolves agent and injects kwargs', async () => {
  const { chatCompletion } = require('../bin/model_client');

  const originalFetch = globalThis.fetch;
  const mockFetch = test.mock.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ choices: [] })
  }));
  globalThis.fetch = mockFetch;

  try {
    const config = {
      model: { provider: 'openai', name: 'gemma-4', baseUrl: 'http://localhost:5001/v1' },
      activeModelTarget: { model: 'gemma-4', baseUrl: 'http://localhost:5001/v1', provider: 'openai' }
    };

    // 1. Using a string activeAgent ID
    const ctxString = {
      config,
      conversationHistory: [],
      getAllTools: () => [],
      activeAgent: 'code_editor'
    };
    await chatCompletion(ctxString);
    const call1 = mockFetch.mock.calls[0];
    const body1 = JSON.parse(call1.arguments[1].body);
    assert.equal(body1.chat_template_kwargs?.thinking_enabled, true);

    // 2. Using an object activeAgent
    const ctxObject = {
      config,
      conversationHistory: [],
      getAllTools: () => [],
      activeAgent: getAgent('conductor')
    };
    await chatCompletion(ctxObject);
    const call2 = mockFetch.mock.calls[1];
    const body2 = JSON.parse(call2.arguments[1].body);
    assert.equal(body2.chat_template_kwargs?.thinking_enabled, true);

    // 3. Fallback to currentTaskType
    const ctxTask = {
      config,
      conversationHistory: [],
      getAllTools: () => [],
      currentTaskType: 'coding'
    };
    await chatCompletion(ctxTask);
    const call3 = mockFetch.mock.calls[2];
    const body3 = JSON.parse(call3.arguments[1].body);
    assert.equal(body3.chat_template_kwargs?.thinking_enabled, true);

    // 4. Fallback to disabled task type
    const ctxTaskDisabled = {
      config,
      conversationHistory: [],
      getAllTools: () => [],
      currentTaskType: 'search'
    };
    await chatCompletion(ctxTaskDisabled);
    const call4 = mockFetch.mock.calls[3];
    const body4 = JSON.parse(call4.arguments[1].body);
    assert.equal(body4.chat_template_kwargs?.thinking_enabled, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
