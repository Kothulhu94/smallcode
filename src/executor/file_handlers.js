const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sanitizeToolOutput, safeResolvePath, escapeShellArg, normalizeRelativePathOrPattern, globSearchFallback } = require('../security/sanitize');
const { getReadTracker } = require('../tools/read_tracker');
const { getFileStateTracker } = require('../session/file_state');
const { getSnapshotManager } = require('../session/snapshot');

function showMiniDiff(tui, filePath, oldStr, newStr, lineNum) {
  if (!tui) return;
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

async function handleReadFile(args, cwd) {
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `read_file rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
  // Mark as read so the write-guard (Feature 5) lets subsequent writes through
  try { getReadTracker().recordRead(filePath, cwd); } catch {}
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const start = (args.start_line || 1) - 1;
  const end = args.end_line || lines.length;
  const slice = lines.slice(start, end);
  // Sanitize before sending to the model: strip ANSI/control chars and
  // redact any secrets the file may contain (e.g. .env, token files).
  const safeSlice = slice.map(l => sanitizeToolOutput(l));
  const numbered = safeSlice.map((l, i) => `${String(start + i + 1).padStart(4)}│ ${l}`).join('\n');

  // Diff-based context (Feature #16): when SMALLCODE_DIFF_CONTEXT=true
  // and the model has already read this file, return a diff instead of the
  // full content. Falls back to full content if diff is too large or if the
  // file hasn't changed. Only applies when no line range is requested.
  if (!args.start_line && !args.end_line) {
    try {
      const tracker = getFileStateTracker();
      const result = tracker.record(filePath, content);
      if (result.mode === 'unchanged') {
        return { result: `${args.path} (${lines.length} lines — unchanged since last read, no diff)` };
      }
      if (result.mode === 'diff') {
        return { result: `${args.path} changes since last read (${result.fullLength} lines total):\n${sanitizeToolOutput(result.diff)}` };
      }
      // mode === 'full' — fall through to normal path below
    } catch {} // diff tracker failure is always non-fatal
  }

  // Feature 2: summarize large files (>200 lines, no line range requested)
  // This saves context by replacing the full file with signatures + key logic
  if (lines.length > 200 && !args.start_line && !args.end_line) {
    try {
      const { summarizeFileCompiled } = require('../../bin/features_adapter');
      if (summarizeFileCompiled) {
        const summary = await summarizeFileCompiled(args.path, content, 600);
        if (summary && summary.length > 50) {
          return { result: `${args.path} (${lines.length} lines — summarized):\n${sanitizeToolOutput(summary)}` };
        }
      }
    } catch {} // fall through to full content on any error
  }

  return { result: `${args.path} (${lines.length} lines):\n${numbered}` };
}

async function handleWriteFile(args, cwd, _fullscreenRef) {
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `write_file rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  // Read-before-write guard — small models often overwrite files they
  // never read. First write to an unread existing file is refused with
  // a hint; second attempt allowed (so legitimate "fully replace" intents
  // succeed). Disable with SMALLCODE_WRITE_GUARD=false.
  const tracker = getReadTracker();
  const guard = tracker.checkWrite(filePath, cwd);
  if (!guard.ok) {
    return { error: guard.reason };
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Guard against corrupted large writes — if content is suspiciously large
  // (>200KB) or empty after a JSON parse error, refuse rather than corrupt.
  if (!args.content && args.content !== '') {
    return { error: `write_file: content is missing or undefined for ${args.path}` };
  }
  // Content length guard — llama.cpp JSON parser fails at ~13k chars in tool_call arguments.
  // We enforce a limit well below that. For new large files, the model must use a
  // skeleton + patch strategy (instructed in the system prompt).
  const MAX_CONTENT_CHARS = 8000; // ~200 lines of dense code, well under llama.cpp's limit
  if (args.content.length > MAX_CONTENT_CHARS) {
    const lineCount = args.content.split('\n').length;
    return {
      error: `write_file: content too large (${lineCount} lines / ${Math.round(args.content.length/1024)}KB). ` +
        `llama.cpp cannot parse tool calls larger than ~8KB. ` +
        `Strategy: write a skeleton file first (imports + empty function stubs), ` +
        `then use multiple patch calls to fill in each section. ` +
        `Keep each write_file under 60 lines.`,
    };
  }
  const existed = fs.existsSync(filePath);
  const oldContent = existed ? fs.readFileSync(filePath, 'utf-8') : null;
  // Snapshot for auto-rollback (Feature 9). No-op if no checkpoint open.
  try { getSnapshotManager({ workdir: cwd }).note(filePath, oldContent); } catch {}
  fs.writeFileSync(filePath, args.content);
  tracker.recordWrite(filePath, cwd);
  // Update diff tracker so subsequent reads see the new state
  try { getFileStateTracker().recordWrite(filePath, args.content); } catch {}
  const lineCount = args.content.split('\n').length;
  const action = existed ? 'Updated' : 'Created';
  if (_fullscreenRef && existed && oldContent) {
    const preview = oldContent.split('\n').slice(0, 5).join('\n');
    const newPreview = args.content.split('\n').slice(0, 5).join('\n');
    _fullscreenRef.addDiff(args.path, preview + '\n...', newPreview + '\n...', 1);
  }
  return { result: `${action} ${args.path} (${lineCount} lines)`, action, path: args.path, lines: lineCount };
}

async function handleAppendFile(args, cwd) {
  // append_file: lets the model build large files in chunks, avoiding
  // llama.cpp's ~13KB JSON parse limit that breaks large write_file calls.
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `append_file rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  if (!args.content && args.content !== '') {
    return { error: 'append_file: content is missing' };
  }
  if (args.content.length > 8000) {
    return { error: `append_file: chunk too large (${Math.round(args.content.length/1024)}KB). Keep each append under 60 lines.` };
  }
  if (!fs.existsSync(filePath)) {
    return { error: `append_file: file not found: ${args.path}. Create it first with write_file.` };
  }
  const before = fs.readFileSync(filePath, 'utf-8');
  // Snapshot for auto-rollback (Feature 9) — record state before appending
  try { getSnapshotManager({ workdir: cwd }).note(filePath, before); } catch {}
  // Add newline separator if file doesn't end with one
  const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const newContent = before + sep + args.content;
  fs.writeFileSync(filePath, newContent);
  try { getFileStateTracker().recordWrite(filePath, newContent); } catch {}
  try { getReadTracker().recordWrite(filePath, cwd); } catch {}
  const totalLines = newContent.split('\n').length;
  const addedLines = args.content.split('\n').length;
  return { result: `Appended ${addedLines} lines to ${args.path} (now ${totalLines} lines total)`, action: 'Appended', path: args.path };
}

async function handlePatch(args, cwd, _fullscreenRef, tui) {
  const __missing = ['path', 'old_str', 'new_str']
    .filter(k => typeof args[k] !== 'string');
  if (__missing.length) {
    return {
      error: `patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
             `received: ${JSON.stringify(args).slice(0, 200)}`,
      kind: 'validation',
    };
  }
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `patch rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
  // Patching counts as having read the file (it requires old_str matching)
  try { getReadTracker().recordRead(filePath, cwd); } catch {}
  let content = fs.readFileSync(filePath, 'utf-8');
  // Snapshot for auto-rollback (Feature 9). No-op if no checkpoint open.
  try { getSnapshotManager({ workdir: cwd }).note(filePath, content); } catch {}
  const count = content.split(args.old_str).length - 1;
  if (count === 0) {
    // MarrowScript Rank 7: semantic_merge — recover from old_str not found.
    // When the model tries to patch a file but provides an old_str that
    // doesn't exactly match (e.g. whitespace drift from tokenization),
    // semanticMerge attempts a fuzzy reconstruction. The result is a full
    // file replacement, not a surgical patch — acceptable as a fallback
    // because the original old_str already failed to match.
    try {
      const { semanticMerge } = require('../../bin/features_adapter');
      if (semanticMerge) {
        const merged = await semanticMerge(args.path, args.new_str, content);
        if (merged && merged.length > 0) {
          // Strip ANSI codes from model-returned content before writing to disk
          const { stripAnsi: _stripAnsiMerge } = require('../security/sanitize');
          const cleanMerged = _stripAnsiMerge ? _stripAnsiMerge(merged) : merged;
          fs.writeFileSync(filePath, cleanMerged);
          try { getFileStateTracker().recordWrite(filePath, cleanMerged); } catch {}
          const oldLines = content.split('\n').length;
          const newLines = cleanMerged.split('\n').length;
          if (_fullscreenRef) {
            _fullscreenRef.addDiff(args.path, content.slice(0, 200), cleanMerged.slice(0, 200), 1);
          } else {
            showMiniDiff(tui, args.path, content.slice(0, 200), cleanMerged.slice(0, 200), 1);
          }
          return { result: `Patched ${args.path} via semantic merge (${oldLines} → ${newLines} lines)`, action: 'Edited', path: args.path, line: 1 };
        }
      }
    } catch {}
    return { error: `old_str not found in ${args.path}` };
  }
  if (count > 1) return { error: `old_str matches ${count} locations. Include more context.` };
  content = content.replace(args.old_str, args.new_str);
  fs.writeFileSync(filePath, content);
  try { getFileStateTracker().recordWrite(filePath, content); } catch {}
  const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
  const oldLines = args.old_str.split('\n').length;
  const newLines = args.new_str.split('\n').length;
  if (_fullscreenRef) {
    _fullscreenRef.addDiff(args.path, args.old_str, args.new_str, lineNum);
  } else {
    showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
  }
  return { result: `Patched ${args.path}: replaced ${oldLines} lines with ${newLines} lines at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
}

async function handleReadAndPatch(args, cwd, tui) {
  const __missing = ['path', 'old_str', 'new_str']
    .filter(k => typeof args[k] !== 'string');
  if (__missing.length) {
    return {
      error: `read_and_patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
             `received: ${JSON.stringify(args).slice(0, 200)}`,
      kind: 'validation',
    };
  }
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `read_and_patch rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
  let content = fs.readFileSync(filePath, 'utf-8');
  const count = content.split(args.old_str).length - 1;
  if (count === 0) {
    const lines = content.split('\n').slice(0, 50);
    const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${sanitizeToolOutput(l)}`).join('\n');
    return { error: `old_str not found. File content:\n${numbered}` };
  }
  if (count > 1) return { error: `old_str matches ${count} locations. Be more specific.` };
  content = content.replace(args.old_str, args.new_str);
  fs.writeFileSync(filePath, content);
  const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
  showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
  return { result: `Read and patched ${args.path} at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
}

async function handleCreateAndRun(args, cwd) {
  const __missing = ['path', 'content']
    .filter(k => typeof args[k] !== 'string');
  if (__missing.length) {
    return {
      error: `create_and_run: missing or non-string arg(s): ${__missing.join(', ')}. ` +
             `received: ${JSON.stringify(args).slice(0, 200)}`,
      kind: 'validation',
    };
  }
  const safe = safeResolvePath(args.path, cwd);
  if (!safe.ok) return { error: `create_and_run rejected: ${safe.reason}` };
  const filePath = safe.fullPath;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Apply the same 8KB guard as write_file — llama.cpp can't parse larger tool calls
  if (args.content && args.content.length > 8000) {
    return { error: `create_and_run: content too large (${args.content.split('\n').length} lines). Use write_file (skeleton) + append_file (sections) + bash to run.` };
  }
  fs.writeFileSync(filePath, args.content || '');
  const lines = args.content.split('\n').length;
  let output = `Created ${args.path} (${lines} lines)`;
  let cmdError = false;
  if (args.command) {
    // Check if the file contains interactive input calls that would block
    const hasInteractive = args.content && (
      args.content.includes('input(') ||     // Python input()
      args.content.includes('readline') ||    // Node readline
      args.content.includes('process.stdin') || // Node stdin
      args.content.includes('Scanner(') ||    // Java Scanner
      args.content.includes('gets') ||        // Ruby gets
      args.content.includes('read()')         // generic read
    );
    if (hasInteractive) {
      output += `\n⚠ File contains interactive input calls (input/readline/stdin). Skipping execution — the script would hang waiting for user input. Use node --check or python -c "import py_compile; py_compile.compile('${args.path}')" to verify syntax instead.`;
      return { result: output, action: 'Created', path: args.path, lines };
    }
    // Also check for server-start patterns (same conservative matching as bash case)
    const blockingPatterns = /^(node|python|python3|ruby|php)\s+.*\b(server\.(js|py|rb|php)|app\.(js|py|rb|php))\b/i;
    const explicitServers = /\b(uvicorn|gunicorn|flask|django|express|fastify|npm\s+start)\b/i;
    if (blockingPatterns.test(args.command) || explicitServers.test(args.command)) {
      if (!args.command.includes('--check') && !args.command.includes('test')) {
        output += `\n⚠ Command would start a long-running server. Skipping execution.`;
        return { result: output, action: 'Created', path: args.path, lines };
      }
    }
    try {
      const cmdOut = execSync(args.command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024*1024 });
      output += `\n$ ${args.command}\n${cmdOut.slice(0, 2000)}`;
    } catch (e) {
      cmdError = true;
      const errOut = (e.stdout || '') + (e.stderr || e.message || '');
      output += `\n$ ${args.command}\n${(e.status === null || e.status === undefined) ? 'TIMED OUT' : 'EXIT CODE ' + (e.status || 1)} — FAILED:\n${errOut.slice(0, 2000)}`;
    }
  }
  return { result: output, action: 'Created', path: args.path, lines, error: cmdError ? `Command failed: ${args.command}` : null };
}

async function handleFindAndRead(args, cwd) {
  try {
    const pattern = normalizeRelativePathOrPattern(args.pattern, cwd);
    let files = [];
    try {
      const cmd = 'rg --files --glob ' + escapeShellArg(String(pattern || ''))
        + ' --glob ' + escapeShellArg('!node_modules')
        + ' --glob ' + escapeShellArg('!.git');
      const found = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
      files = found.trim().split('\n').filter(Boolean);
    } catch {
      files = globSearchFallback(pattern, cwd);
    }
    if (files.length === 0) return { result: 'No files found matching: ' + args.pattern };
    const target = files[0];
    // Re-validate the target through safeResolvePath. ripgrep --files
    // can in theory follow symlinks outside cwd; we want to refuse
    // serving up content from outside the project.
    const safeTarget = safeResolvePath(target, cwd);
    if (!safeTarget.ok) return { error: `find_and_read rejected: ${safeTarget.reason}` };
    const content = fs.readFileSync(safeTarget.fullPath, 'utf-8');
    const maxLines = args.read_lines || 50;
    const lines = content.split('\n').slice(0, maxLines);
    const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${sanitizeToolOutput(l)}`).join('\n');
    let output = `Found ${files.length} files. Reading ${target} (${content.split('\n').length} lines):\n${numbered}`;
    if (files.length > 1) output += `\n\nOther matches: ${files.slice(1, 5).join(', ')}`;
    return { result: output };
  } catch { return { result: 'No files found matching: ' + args.pattern }; }
}

async function handleSearchAndRead(args, cwd) {
  try {
    const readCtx = Number.isInteger(args.read_context) && args.read_context > 0 && args.read_context < 200
      ? args.read_context
      : 10;
    const cmd = buildCommand(
      'rg',
      ['--line-number', '-C', String(readCtx), '--max-count', '3'],
      String(args.pattern || ''),
    ) + ' . --glob ' + escapeShellArg('!node_modules') + ' --glob ' + escapeShellArg('!.git');
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
    return { result: sanitizeToolOutput(output).slice(0, 4000) || 'No matches.' };
  } catch { return { result: 'No matches found for: ' + args.pattern }; }
}

module.exports = {
  handleReadFile,
  handleWriteFile,
  handleAppendFile,
  handlePatch,
  handleReadAndPatch,
  handleCreateAndRun,
  handleFindAndRead,
  handleSearchAndRead
};
