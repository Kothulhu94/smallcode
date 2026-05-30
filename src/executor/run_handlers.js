const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getShell } = require('../../bin/memory');
const { sanitizeToolOutput } = require('../security/sanitize');
const { rtkRewrite } = require('./rtk_rewrite');

async function handleBash(args, cwd, flags, _fullscreenRef, config, tui) {
  let command = args.command;

  // RTK (Rust Token Killer) auto-rewrite — if rtk is on PATH, prefix supported
  // commands to compress output by 60-90% before it reaches the model's context.
  // Opt-out: set SMALLCODE_RTK=false in .env
  // Docs: https://github.com/rtk-ai/rtk
  if (process.env.SMALLCODE_RTK !== 'false') {
    command = rtkRewrite(command);
  }

  // Detect commands that start long-running servers (will block and timeout).
  // IMPORTANT: only block on actual server indicators — NOT generic filenames
  // like main.py, index.js which are standard entry points that run and exit.
  // Match: files explicitly named *server*, *app* (as standalone), or framework
  // scripts that are always blocking (uvicorn, gunicorn, etc.)
  const blockingPatterns = /^(node|python|python3|ruby|php|go run|deno run|bun run)\s+.*\b(server\.(js|py|rb|php|ts)|app\.(js|py|rb|php|ts))\b/i;
  const explicitServers = /\b(uvicorn|gunicorn|rails\s+s|npm\s+start|yarn\s+start|npm\s+run\s+dev|python3?\s+-m\s+(flask|django|uvicorn|aiohttp\.web|fastapi)|puma|unicorn|passenger)\b/i;
  if (blockingPatterns.test(command) || explicitServers.test(command)) {
    // Check if it's actually a --check or test command (those are fine)
    if (!command.includes('--check') && !command.includes('--version') && !command.includes('test')) {
      return {
        result: `Refused: "${command}" would start a long-running server that blocks. Use "node --check <file>" to verify syntax, or describe what you want to test and I'll use a non-blocking approach.`,
        error: 'Blocking command detected',
        command,
      };
    }
  }

  // Detect scripts with interactive input (will EOF or block forever)
  const scriptMatch = command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
  if (scriptMatch && !command.includes('--check') && !command.includes('-c') && !command.includes('-m')) {
    const targetFile = path.resolve(cwd, scriptMatch[1]);
    if (fs.existsSync(targetFile)) {
      const fc = fs.readFileSync(targetFile, 'utf-8');
      if (fc.includes('input(') || fc.includes('readline.question') || fc.includes('process.stdin.on')) {
        return {
          result: `Refused: "${command}" — file contains interactive input() calls that block in non-interactive mode. File created successfully. Verify syntax: python -m py_compile ${scriptMatch[1]}`,
          error: 'Interactive script detected',
          command,
        };
      }
    }
  }

  if (process.platform === 'win32') {
    command = command.replace(/^ls\b/, 'dir').replace(/^ls /, 'dir ').replace(/^cat /, 'type ').replace(/^rm -rf /, 'rmdir /s /q ').replace(/^rm /, 'del ').replace(/^touch /, 'echo.>').replace(/^cp /, 'copy ').replace(/^mv /, 'move ').replace(/^mkdir -p /, 'mkdir ');
  }
  if (flags && flags.verbose && _fullscreenRef) {
    _fullscreenRef.addTool('bash', 'ok', `$ ${command}`);
  }

  // Persistent shell session: by default ON, can be disabled with
  // SMALLCODE_SHELL_PERSIST=false. Maintains cwd, env vars, and shell
  // state across calls so `cd src` followed by `ls` works as expected.
  const usePersistent = process.env.SMALLCODE_SHELL_PERSIST !== 'false';
  if (usePersistent) {
    try {
      const shell = getShell({ cwd, timeout: 30000 });
      const result = await shell.run(command);
      const maxOutput = (config && config.context?.detected_window || 128000) < 64000 ? 1500 : 3000;
      const safeOutput = result.stdout || '';
      const trimmed = safeOutput.length > maxOutput
        ? safeOutput.slice(0, maxOutput - 500) + '\n...(truncated)...\n' + safeOutput.slice(-300)
        : safeOutput;
      if (flags && flags.verbose && _fullscreenRef && trimmed.trim()) {
        const lines = trimmed.split('\n').slice(0, 10);
        for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
      }
      if (result.timedOut) {
        return { result: trimmed || '(no output before timeout)', error: 'Timed out (killed after 30s)', command };
      }
      if (result.error) {
        return { result: trimmed, error: result.error, command };
      }
      if (result.exitCode !== 0) {
        // MarrowScript Rank 4: error_diagnosis — structured hint prepended to result
        let diagHint = '';
        try {
          const { diagnoseError } = require('../../bin/features_adapter');
          if (diagnoseError) {
            const diag = await diagnoseError(command, result.stdout || '', result.exitCode);
            if (diag && diag.suggestion) {
              const loc = diag.file ? ` in ${diag.file}${diag.line ? ':' + diag.line : ''}` : '';
              diagHint = `[ERROR-DIAGNOSIS] Type: ${diag.type}${loc}. Fix: ${diag.suggestion}\n\n`;
            }
          }
        } catch {}
        return { result: diagHint + (trimmed || '(no output)'), error: `Exit code ${result.exitCode}`, command };
      }
      return { result: trimmed || '(no output)', command };
    } catch (e) {
      // Fall through to one-shot execSync if persistent shell errors
    }
  }

  // Fallback: one-shot execSync (original behavior, no state retention)
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
    const maxOutput = (config && config.context?.detected_window || 128000) < 64000 ? 1500 : 3000;
    const safeOutput = sanitizeToolOutput(output);
    const trimmed = safeOutput.length > maxOutput ? safeOutput.slice(0, maxOutput - 500) + '\n...(truncated)...\n' + safeOutput.slice(-300) : safeOutput;
    if (flags && flags.verbose && _fullscreenRef && trimmed.trim()) {
      const lines = trimmed.split('\n').slice(0, 10);
      for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
    }
    return { result: trimmed || '(no output)', command };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const safeOutput = sanitizeToolOutput(output);
    const exitReason = (e.status === null || e.status === undefined) ? 'Timed out (killed after 30s)' : `Exit code ${e.status}`;
    if (flags && flags.verbose && _fullscreenRef && safeOutput.trim()) {
      const lines = safeOutput.split('\n').slice(0, 8);
      for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
    }
    // MarrowScript Rank 4: error_diagnosis — structured hint for execSync fallback too
    let diagHint = '';
    if (e.status !== null && e.status !== undefined) {
      try {
        const { diagnoseError } = require('../../bin/features_adapter');
        if (diagnoseError) {
          const diag = await diagnoseError(command, safeOutput, e.status);
          if (diag && diag.suggestion) {
            const loc = diag.file ? ` in ${diag.file}${diag.line ? ':' + diag.line : ''}` : '';
            diagHint = `[ERROR-DIAGNOSIS] Type: ${diag.type}${loc}. Fix: ${diag.suggestion}\n\n`;
          }
        }
      } catch {}
    }
    return { result: diagHint + (safeOutput.slice(0, 2000) || sanitizeToolOutput(e.message || '')), error: exitReason, command };
  }
}

async function handleRun(args, cwd) {
  // Check if the target file has interactive input that would block
  const runMatch = args.command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
  if (runMatch) {
    const targetFile = path.resolve(cwd, runMatch[1]);
    if (fs.existsSync(targetFile)) {
      const fileContent = fs.readFileSync(targetFile, 'utf-8');
      if (fileContent.includes('input(') || fileContent.includes('readline') || fileContent.includes('process.stdin')) {
        return {
          result: `Refused: "${args.command}" — the file contains interactive input calls (input/readline/stdin) which cannot work in non-interactive mode. The file was created successfully. To verify syntax, use: python -m py_compile <file> or node --check <file>`,
          error: 'Interactive script detected',
          command: args.command,
        };
      }
    }
  }
  const timeout = (args.timeout || 30) * 1000;
  try {
    const output = execSync(args.command, { encoding: 'utf-8', timeout, cwd, maxBuffer: 1024*1024 });
    return { result: sanitizeToolOutput(output).slice(0, 3000) || '(completed with no output)', command: args.command };
  } catch (e) {
    const errOut = (e.stdout || '') + (e.stderr || e.message || '');
    const exitReason = (e.status === null || e.status === undefined)
      ? `Timed out (killed after ${args.timeout || 30}s)`
      : `Exit code ${e.status || 1}`;
    return { result: `${exitReason.toUpperCase()} — FAILED:\n${sanitizeToolOutput(errOut).slice(0, 2500)}`, error: `Command failed: ${exitReason}`, command: args.command };
  }
}

module.exports = {
  handleBash,
  handleRun
};
