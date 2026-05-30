const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeResolvePath, sanitizeToolOutput, escapeShellArg } = require('../security/sanitize');

async function handleBoneCompile(args, cwd) {
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `bone_compile rejected: ${safe.reason}` };
  const bonePath = safe.fullPath;
  if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
  if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };

  const allowedTargets = new Set(['express', 'nakama', 'prisma', 'sqlite']);
  const target = String(args.target || 'express');
  if (!allowedTargets.has(target)) {
    return { error: `bone_compile: invalid target. Allowed: ${[...allowedTargets].join(', ')}` };
  }
  
  const compilerPaths = [
    path.resolve(__dirname, '..', '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), 
    path.resolve(__dirname, '..', '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')
  ];
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

async function handleBoneCheck(args, cwd) {
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `bone_check rejected: ${safe.reason}` };
  const bonePath = safe.fullPath;
  if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
  if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
  
  const compilerPaths = [
    path.resolve(__dirname, '..', '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), 
    path.resolve(__dirname, '..', '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')
  ];
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

module.exports = {
  handleBoneCompile,
  handleBoneCheck
};
