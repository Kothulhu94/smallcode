#!/usr/bin/env node
// SmallCode — Benchmark Harness
//
// Runs SmallCode against a curated set of small coding tasks, reports pass
// rate, mean time per task, and per-task breakdown. Stores results in
// .smallcode/benchmarks/<run-id>.json so progress is trackable over time.
//
// Suites:
//   - smoke         5 trivial tasks (sanity check, ~30s total)
//   - polyglot-mini 20 short Aider-Polyglot-style exercises across 5 langs
//   - tool-use      10 multi-step tasks that require tool sequencing
//
// Usage:
//   node bench/harness.js [--suite smoke] [--model NAME] [--timeout 180]
//   npm run bench
//
// Each task:
//   1. Creates a fresh temp workspace
//   2. Optionally writes seed files into it
//   3. Runs SmallCode non-interactively with the prompt
//   4. Runs a verification script (compile, test, exit code, file checks)
//   5. Records pass/fail + duration + tool call count

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SMALLCODE_BIN = path.join(ROOT, 'bin', 'smallcode.js');

// ─── Suites ────────────────────────────────────────────────────────────────

const { SUITES } = require('./suites');

// ─── Runner ────────────────────────────────────────────────────────────────

// Load .env from the SmallCode project root so env vars are available
// when we spawn child processes in temp working dirs (which don't have .env).
function loadDotenv(filePath) {
  const env = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {}
  return env;
}

const ROOT_ENV = loadDotenv(path.join(ROOT, '.env'));

function parseArgs(argv) {
  const args = { suite: 'smoke', timeout: 240, model: null, baseUrl: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') args.suite = argv[++i];
    else if (a === '--timeout') args.timeout = parseInt(argv[++i], 10);
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '--task') args.task = argv[++i];
  }
  return args;
}

function runOne(task, opts) {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`));
    if (task.seed) {
      for (const [name, content] of Object.entries(task.seed)) {
        const p = path.join(tmpDir, name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    }

    // Order: ROOT_ENV first so .env values are baseline, then process.env wins
    // for explicit overrides (--model flag etc).
    const env = { ...ROOT_ENV, ...process.env, SMALLCODE_AUTO_APPROVE: 'true' };
    if (opts.model) env.SMALLCODE_MODEL = opts.model;
    if (opts.baseUrl) env.SMALLCODE_BASE_URL = opts.baseUrl;
    if (!env.SMALLCODE_PROVIDER) env.SMALLCODE_PROVIDER = 'openai';
    // Ensure NO_COLOR so the tool-call counter on stdout is reliable
    // (without this, ANSI sequences like \u001b[2m⚙ break our regex).
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0';

    const startMs = Date.now();
    const child = spawn(
      'node',
      [SMALLCODE_BIN, '--non-interactive', '-P', task.prompt],
      {
        cwd: tmpDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached on POSIX so we can kill the whole process group on timeout.
        // (process.kill(-pid, 'SIGKILL') — without detached, child's children
        // survive the kill and keep the harness hanging.)
        detached: process.platform !== 'win32',
      }
    );

    let output = '';
    let toolCalls = 0;
    // Strip ANSI before counting — even with NO_COLOR some libs ignore it
    const ansiRe = /\u001b\[[0-9;]*[a-zA-Z]/g;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      output += s;
      const clean = s.replace(ansiRe, '');
      const m = clean.match(/⚙ /g);
      if (m) toolCalls += m.length;
    });
    child.stderr.on('data', (d) => { output += d.toString(); });

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      try {
        if (process.platform === 'win32') {
          // taskkill the whole tree on Windows
          require('child_process').exec(`taskkill /pid ${child.pid} /T /F`).on('error', () => {});
        } else {
          // Negative PID = whole process group (detached: true above made this possible)
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        }
      } catch {}
    }, (opts.timeout || 180) * 1000);

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      const elapsedMs = Date.now() - startMs;
      let passed = false;
      let verifyError = null;
      try {
        passed = !!task.verify({ dir: tmpDir, output, exitCode: code });
      } catch (e) {
        verifyError = e.message;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve({
        id: task.id,
        lang: task.lang,
        passed,
        elapsedMs,
        exitCode: code,
        toolCalls,
        verifyError: verifyError || (killed ? 'timeout — killed' : null),
        timedOut: killed,
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    console.log('Available suites:');
    for (const name of Object.keys(SUITES)) {
      console.log(`  ${name.padEnd(16)} ${SUITES[name].length} tasks`);
    }
    process.exit(0);
  }

  const suite = SUITES[args.suite];
  if (!suite) {
    console.error(`Unknown suite: ${args.suite}. Available: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }

  const tasks = args.task ? suite.filter(t => t.id === args.task) : suite;
  if (tasks.length === 0) {
    console.error(`No tasks matched.`);
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
  console.log(`SmallCode Benchmark — suite: ${args.suite}, tasks: ${tasks.length}, run: ${runId}`);
  console.log(`Model: ${args.model || process.env.SMALLCODE_MODEL || '(from .env)'}`);
  console.log('');

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    process.stdout.write(`[${i+1}/${tasks.length}] ${t.id.padEnd(28)} ... `);
    const r = await runOne(t, args);
    results.push(r);
    const mark = r.passed ? '✅' : '❌';
    const dur = (r.elapsedMs / 1000).toFixed(1) + 's';
    const calls = `${r.toolCalls}t`;
    console.log(`${mark} ${dur.padStart(6)} ${calls.padStart(5)}${r.verifyError ? ` (verify err: ${r.verifyError})` : ''}`);
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const totalMs = results.reduce((s, r) => s + r.elapsedMs, 0);
  const meanMs = totalMs / total;

  console.log('');
  console.log(`──── Summary ────`);
  console.log(`Pass rate    : ${passed}/${total} (${Math.round(passed/total*100)}%)`);
  console.log(`Total time   : ${(totalMs/1000).toFixed(1)}s`);
  console.log(`Mean per task: ${(meanMs/1000).toFixed(1)}s`);

  // Per-language breakdown
  const byLang = {};
  for (const r of results) {
    if (!byLang[r.lang]) byLang[r.lang] = { passed: 0, total: 0 };
    byLang[r.lang].total++;
    if (r.passed) byLang[r.lang].passed++;
  }
  console.log('');
  console.log('Per language:');
  for (const [lang, stats] of Object.entries(byLang)) {
    console.log(`  ${lang.padEnd(12)} ${stats.passed}/${stats.total}`);
  }

  // Persist result
  const benchDir = path.join(process.cwd(), '.smallcode', 'benchmarks');
  fs.mkdirSync(benchDir, { recursive: true });
  const outPath = path.join(benchDir, `${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    runId,
    suite: args.suite,
    model: args.model || process.env.SMALLCODE_MODEL,
    baseUrl: args.baseUrl || process.env.SMALLCODE_BASE_URL,
    startedAt: new Date().toISOString(),
    summary: { passed, total, totalMs, meanMs, byLang },
    results,
  }, null, 2));
  console.log('');
  console.log(`Saved: ${outPath}`);

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
