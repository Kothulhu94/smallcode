#!/usr/bin/env node
'use strict';

// SmallCode — E2E offline checks
//
// Validates the wiring of new features (issues #52, #53, read-guard,
// quality-monitor) without requiring a live LLM endpoint. The
// e2e_smoke.js script is the live-LLM E2E; this one is what runs in CI
// and on developer machines that don't have a model server up.
//
// Run with: node test/e2e_offline.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'smallcode.js');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m',
};
const paint = (t, code) => process.stdout.isTTY ? `${code}${t}${C.reset}` : t;

let failures = 0;
function check(name, ok, details) {
  if (ok) {
    console.log(`  ${paint('✓', C.green)} ${name}`);
  } else {
    failures += 1;
    console.log(`  ${paint('✗', C.red)} ${name}`);
    if (details) console.log(`      ${paint(details, C.dim)}`);
  }
}

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// ─── 1. CLI smoke: --version + --help boot the binary cleanly ───────────────

console.log(paint('SmallCode E2E (offline)', C.bold));

console.log('\n' + paint('Case 1 — CLI --version exits 0', C.bold));
const ver = spawnSync('node', [BIN, '--version'], { encoding: 'utf-8' });
check('exit 0', ver.status === 0, `status=${ver.status}, stderr=${ver.stderr}`);
check('prints "smallcode v"', /smallcode v\d+\.\d+\.\d+/.test(ver.stdout),
      `stdout: ${ver.stdout}`);

console.log('\n' + paint('Case 2 — CLI --help exits 0', C.bold));
const help = spawnSync('node', [BIN, '--help'], { encoding: 'utf-8' });
check('exit 0', help.status === 0);
check('prints USAGE block', /USAGE:/.test(help.stdout));

// ─── 2. SkillManager wiring (closes #52, #53) ──────────────────────────────

console.log('\n' + paint('Case 3 — SkillManager auto-detects nested + CRLF', C.bold));
const { SkillManager } = require(path.join(ROOT, 'src', 'plugins', 'skills'));

const proj = freshDir('sc-e2e-skills');
fs.mkdirSync(path.join(proj, '.smallcode', 'skills'), { recursive: true });
fs.writeFileSync(
  path.join(proj, '.smallcode', 'skills', 'crlf.md'),
  '---\r\nname: crlf\r\ntrigger: manual\r\n---\r\nbody\r\n',
);
fs.mkdirSync(path.join(proj, '.agents', 'skills', 'jukefr-style'), { recursive: true });
fs.writeFileSync(path.join(proj, '.agents', 'skills', 'jukefr-style', 'SKILL.md'),
                 '# itsy-style nested skill body');
fs.mkdirSync(path.join(proj, '.claude', 'skills', 'claude-style'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'skills', 'claude-style', 'SKILL.md'),
                 '# claude-style nested skill body');

const sm = new SkillManager(proj);
check('CRLF skill loads (issue #52)', !!sm.get('crlf'));
check('.agents/skills nested skill loads (issue #53)', !!sm.get('jukefr-style'));
check('.claude/skills nested skill loads (issue #53)', !!sm.get('claude-style'));

// ─── 3. read_guard wiring ──────────────────────────────────────────────────

console.log('\n' + paint('Case 4 — read_guard trims large reads with redirect', C.bold));
const { applyReadGuard } = require(path.join(ROOT, 'src', 'session', 'read_guard'));

const big = Array.from({ length: 1500 }, (_, i) => `line-${i + 1}-${'x'.repeat(40)}`).join('\n');
const guard = applyReadGuard({
  toolName: 'read_file',
  content: big,
  history: [{ role: 'user', content: 'x'.repeat(80000) }],
  config: { context: { detected_window: 32768, max_budget_pct: 70 } },
  fixedCap: 8000,
  headLines: 30,
});
check('trim activated on large file under context pressure', guard.trimmed);
check('reason recorded as context-pressure or fixed-cap-with-hint',
      guard.reason === 'context-pressure' || guard.reason === 'fixed-cap-with-hint');
check('output contains a redirect directive (grep / range / re-read)',
      /grep|range|re-read|read.*range/i.test(guard.content),
      `content head: ${guard.content.slice(0, 200)}`);

// ─── 4. quality_monitor wiring ─────────────────────────────────────────────

console.log('\n' + paint('Case 5 — quality_monitor catches structural failures', C.bold));
const { QualityMonitor } = require(path.join(ROOT, 'src', 'governor', 'quality_monitor'));

const qm = new QualityMonitor();
const empty = qm.inspect({ message: { content: '', tool_calls: [] }, knownTools: ['read_file'] });
check('empty turn fires empty_response', empty && empty.kind === 'empty_response');

qm.reset();
const halluc = qm.inspect({
  message: { content: '', tool_calls: [{ function: { name: 'no_such_tool', arguments: '{}' } }] },
  knownTools: ['read_file', 'patch'],
});
check('hallucinated tool fires hallucinated_tool', halluc && halluc.kind === 'hallucinated_tool');
check('hallucinated correction lists closest matches',
      halluc && /read_file|patch/.test(halluc.injection));

qm.reset();
qm.inspect({
  message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
  knownTools: ['read_file'],
});
const repeat = qm.inspect({
  message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
  knownTools: ['read_file'],
});
check('cross-turn repeat fires repeat_call', repeat && repeat.kind === 'repeat_call');

// ─── 5. bin/smallcode.js still parses after wiring edits ───────────────────

console.log('\n' + paint('Case 6 — bin/smallcode.js parses without errors', C.bold));
const parse = spawnSync('node', ['--check', BIN], { encoding: 'utf-8' });
check('node --check exits 0', parse.status === 0,
      `stderr: ${parse.stderr.slice(0, 400)}`);

console.log('');
if (failures === 0) {
  console.log(paint('All offline E2E checks passed.', C.green + C.bold));
  process.exit(0);
} else {
  console.log(paint(`${failures} offline E2E check(s) failed.`, C.red + C.bold));
  process.exit(1);
}
