// SmallCode — Trace Recorder
// Records agent execution traces (tool calls, responses, validations)
// for replay, debugging, and test generation.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TraceRecorder {
  constructor(workdir) {
    this.workdir = workdir || process.cwd();
    this.tracesDir = path.join(this.workdir, '.smallcode', 'traces');
    this.current = null; // Active trace
    this.recording = false;
  }

  /**
   * Start recording a new trace.
   */
  start(prompt, model) {
    this.current = {
      id: crypto.randomUUID().slice(0, 8),
      model,
      prompt,
      startedAt: new Date().toISOString(),
      steps: [],
      tokens: { prompt: 0, completion: 0 },
    };
    this.recording = true;
    return this.current.id;
  }

  /**
   * Record a tool call step.
   */
  recordToolCall(name, args, result, durationMs) {
    if (!this.recording || !this.current) return;
    this.current.steps.push({
      type: 'tool_call',
      name,
      args,
      result: typeof result === 'string' ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000),
      durationMs,
      timestamp: Date.now(),
    });
  }

  /**
   * Record a model response (text or tool decision).
   */
  recordModelResponse(content, toolCalls) {
    if (!this.recording || !this.current) return;
    this.current.steps.push({
      type: 'model_response',
      content: content ? content.slice(0, 1000) : null,
      toolCalls: toolCalls ? toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments })) : null,
      timestamp: Date.now(),
    });
  }

  /**
   * Record token usage for this trace.
   */
  recordTokens(promptTokens, completionTokens) {
    if (!this.recording || !this.current) return;
    this.current.tokens.prompt += promptTokens || 0;
    this.current.tokens.completion += completionTokens || 0;
  }

  /**
   * Record a validation result.
   */
  recordValidation(filePath, passed, errors) {
    if (!this.recording || !this.current) return;
    this.current.steps.push({
      type: 'validation',
      filePath,
      passed,
      errors: errors ? errors.slice(0, 5) : [],
      timestamp: Date.now(),
    });
  }

  /**
   * Stop recording and save the trace.
   */
  stop() {
    if (!this.recording || !this.current) return null;
    this.current.endedAt = new Date().toISOString();
    this.current.durationMs = Date.now() - new Date(this.current.startedAt).getTime();
    this.recording = false;

    // Save to disk
    if (!fs.existsSync(this.tracesDir)) fs.mkdirSync(this.tracesDir, { recursive: true });
    const filePath = path.join(this.tracesDir, `${this.current.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.current, null, 2));

    const saved = this.current;
    this.current = null;
    return saved;
  }

  /**
   * List all saved traces.
   */
  list() {
    if (!fs.existsSync(this.tracesDir)) return [];
    return fs.readdirSync(this.tracesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.tracesDir, f), 'utf-8'));
          return {
            id: data.id,
            prompt: (data.prompt || '').slice(0, 60),
            model: data.model,
            steps: data.steps.length,
            tokens: data.tokens,
            startedAt: data.startedAt,
            durationMs: data.durationMs,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  /**
   * Load a trace by ID.
   */
  load(id) {
    const filePath = path.join(this.tracesDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /**
   * Generate a test file from a trace (trace-to-test).
   * Creates a Jest-compatible test that replays the tool calls.
   */
  generateTest(traceId) {
    const trace = this.load(traceId);
    if (!trace) return null;

    const toolSteps = trace.steps.filter(s => s.type === 'tool_call');
    if (toolSteps.length === 0) return null;

    const testLines = [
      `// Auto-generated from trace ${trace.id}`,
      `// Original prompt: "${trace.prompt.slice(0, 80).replace(/"/g, '\\"')}"`,
      `// Model: ${trace.model} | Steps: ${trace.steps.length} | Tokens: ${trace.tokens.prompt + trace.tokens.completion}`,
      ``,
      `const { execSync } = require('child_process');`,
      `const fs = require('fs');`,
      `const path = require('path');`,
      ``,
      `describe('Trace ${trace.id}: ${trace.prompt.slice(0, 40).replace(/'/g, "\\'")}', () => {`,
    ];

    for (let i = 0; i < toolSteps.length; i++) {
      const step = toolSteps[i];
      if (step.name === 'write_file' || step.name === 'patch') {
        const args = typeof step.args === 'string' ? JSON.parse(step.args) : step.args;
        testLines.push(`  test('step ${i + 1}: ${step.name} ${(args.path || '').slice(0, 30)}', () => {`);
        testLines.push(`    // Tool: ${step.name} took ${step.durationMs}ms`);
        if (step.name === 'write_file') {
          testLines.push(`    const filePath = path.resolve('${args.path}');`);
          testLines.push(`    // Verify file was created/exists after agent run`);
          testLines.push(`    expect(fs.existsSync(filePath)).toBe(true);`);
        }
        testLines.push(`  });`);
        testLines.push(``);
      } else if (step.name === 'bash') {
        const args = typeof step.args === 'string' ? JSON.parse(step.args) : step.args;
        testLines.push(`  test('step ${i + 1}: bash "${(args.command || '').slice(0, 40)}"', () => {`);
        testLines.push(`    // Verify command succeeds`);
        testLines.push(`    const result = execSync('${(args.command || '').replace(/'/g, "\\'")}', { encoding: 'utf-8', timeout: 15000 });`);
        testLines.push(`    expect(result).toBeDefined();`);
        testLines.push(`  });`);
        testLines.push(``);
      }
    }

    testLines.push(`});`);
    return testLines.join('\n');
  }
}

module.exports = { TraceRecorder };
