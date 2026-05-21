// @ts-nocheck
'use strict';
// Generated from marrow/features_1_6.marrow — prompt callers for features 1, 2, 6.
// Self-contained: uses process.env config + direct fetch (same pattern as bin/model_client.js).
// No dependency on the full cognition provider stack — works in CLI context.

const { createHash } = require('crypto');
const path = require('path');

// ─── Config helpers (mirrors bin/config.js pattern) ──────────────────────────

function _getBaseUrl() {
  return process.env.SMALLCODE_BASE_URL ||
    (process.env.OLLAMA_HOST ? process.env.OLLAMA_HOST + '/v1' : 'http://localhost:1234/v1');
}

function _getModelName() {
  return process.env.SMALLCODE_MODEL || '';
}

function _buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ||
    process.env.DEEPSEEK_API_KEY;
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  return headers;
}

// ─── In-memory cache (keyed by sha256 of prompt name + rendered input) ───────

const _cache = new Map(); // key -> { value, expiresAt }

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}

function _cachePut(key, value, ttlMs) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function _deriveKey(promptName, rendered) {
  return createHash('sha256').update(promptName + ':' + rendered).digest('hex').slice(0, 32);
}

// ─── Template registry (inline — no extension system needed in CLI context) ──

const TEMPLATES = {
  repair_tool_call: (original_call, error, tool_schema) =>
    `The following tool call failed. Fix the JSON and return ONLY the corrected JSON tool call arguments.\n\nOriginal call: ${original_call}\nError: ${error}\nTool schema: ${tool_schema}\n\nReturn ONLY valid JSON.`,

  summarize_file: (file_path, content, target_tokens) =>
    `Summarize this ${file_path} file to function signatures and key logic. Be concise, max ${target_tokens} tokens.\n\n${content}`,

  validate_edit: (file_path, content, original_task) =>
    `Review this edit to ${file_path}. Task was: ${original_task}. Does the code look correct? Reply with 'ok' if it looks good, or describe any issues.\n\n${content}`,

  // MarrowScript Feature #1: intent_clarifier
  // Replaces regex heuristics in src/session/clarify.js with a compiled
  // classifier. Returns exactly "clear" or "vague" — constrained output.
  // Cached 30m by message hash so repeated identical prompts are instant.
  intent_clarifier: (user_message) =>
    `Is this coding task request clear enough to act on, or is it too vague?\n\nA request is VAGUE if it lacks a specific target (e.g. "fix it", "make it better", "do the thing").\nA request is CLEAR if it specifies what to do, even if brief (e.g. "run tests", "fix the null check in auth.js", "add logging").\n\nReply with ONLY one word: "clear" or "vague"\n\nRequest: "${user_message.replace(/"/g, '\\"').slice(0, 300)}"`,
};

// ─── Core fetch helper ────────────────────────────────────────────────────────

async function _chat(rendered, timeoutMs = 20000) {
  const baseUrl = _getBaseUrl();
  const modelName = _getModelName();
  if (!modelName) throw new Error('SMALLCODE_MODEL not set — cannot call model');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: _buildHeaders(),
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: rendered }],
        temperature: 0.1,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const err = await response.text().catch(() => response.status.toString());
      throw new Error(`API ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from model');

    return {
      content,
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Public: callPrompt dispatcher ───────────────────────────────────────────

/**
 * Dispatch a prompt by name.
 * @param {string} name - 'repair_tool_call' | 'summarize_file' | 'validate_edit'
 * @param {object} input - Named input fields
 * @param {object} ctx   - { trace_id }
 * @returns {Promise<string>}
 */
async function callPrompt(name, input, ctx) {
  const tmpl = TEMPLATES[name];
  if (!tmpl) throw new Error(`Unknown prompt: ${name}`);

  const rendered = tmpl(...Object.values(input));
  const cacheKey = _deriveKey(name, rendered);
  const ttlMs = name === 'summarize_file' ? 3600000 :
                name === 'intent_clarifier' ? 1800000 : // 30m — per MarrowScript declaration
                600000;

  const hit = _cacheGet(cacheKey);
  if (hit !== null) return hit;

  const resp = await _chat(rendered, name === 'repair_tool_call' ? 15000 : 20000);
  const value = resp.content;

  _cachePut(cacheKey, value, ttlMs);
  return value;
}

// Export the PROMPTS map for compatibility with features_adapter
const PROMPTS = {
  repair_tool_call: (input, ctx) => callPrompt('repair_tool_call', input, ctx),
  summarize_file: (input, ctx) => callPrompt('summarize_file', input, ctx),
  validate_edit: (input, ctx) => callPrompt('validate_edit', input, ctx),
  intent_clarifier: (input, ctx) => callPrompt('intent_clarifier', input, ctx),
};

function getPrompt(name) {
  const fn = PROMPTS[name];
  if (!fn) throw new Error(`Unknown prompt: ${name}`);
  return fn;
}

module.exports = { callPrompt, PROMPTS, getPrompt };
