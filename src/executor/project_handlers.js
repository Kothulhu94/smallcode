const { execSync } = require('child_process');
const fs = require('fs');
const { escapeShellArg, buildCommand, sanitizeToolOutput } = require('../security/sanitize');

async function handleListProjects(mcpCall) {
  if (typeof mcpCall === 'function') {
    try {
      const listResult = await mcpCall('tools/call', { name: 'list_repos', arguments: {} });
      if (listResult && listResult.content) {
        const data = JSON.parse(listResult.content[0]?.text || '{}');
        const repos = data.repos || [];
        if (repos.length === 0) return { result: 'No projects indexed yet. The code graph is empty.' };
        let output = `Workspace: ${repos.length} indexed projects\n\n`;
        for (const r of repos) {
          output += `• ${r.name} — ${r.file_count || '?'} files, ${r.symbol_count || '?'} symbols, ${(r.languages || []).slice(0, 4).join(', ') || '?'}\n`;
        }
        return { result: output };
      }
    } catch (e) {
      // Ignore MCP errors and fall through to local listing
    }
  }
  try {
    const { formatSmartListing } = require('../tools/file_tree');
    const listing = formatSmartListing(process.cwd(), '', { max: 40 });
    return { result: `Files in ${process.cwd()}:\n${listing}` };
  } catch {
    const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
    return { result: `Projects in ${process.cwd()}:\n${dirs.map(d => `  - ${d.name}/`).join('\n')}` };
  }
}

async function handleGraphSearch(mcpCall, args, cwd) {
  const maxTokens = args.max_tokens || 4000;
  if (typeof mcpCall === 'function') {
    try {
      const graphResult = await mcpCall('tools/call', { name: 'search_graph', arguments: { query: args.query, max_tokens: maxTokens } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: sanitizeToolOutput(text) || 'No results from code graph.' };
      }
    } catch (e) {}
  }
  try {
    const cmd = buildCommand('rg', ['--line-number', '--max-count', '5'], String(args.query || '')) + ' .';
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
    return { result: sanitizeToolOutput(output).slice(0, 3000) };
  } catch { return { result: 'No matches found in code graph or files.' }; }
}

async function handleExplainSymbol(mcpCall, args, cwd) {
  if (typeof mcpCall === 'function') {
    try {
      const graphResult = await mcpCall('tools/call', { name: 'explain_symbol', arguments: { symbol: args.symbol } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: sanitizeToolOutput(text) || `Symbol "${args.symbol}" not found in code graph.` };
      }
    } catch (e) {}
  }
  try {
    const sym = String(args.symbol || '').slice(0, 200);
    if (!/^[A-Za-z_][A-Za-z0-9_:.$-]*$/.test(sym)) {
      return { result: `Symbol "${sym}" is not a valid identifier.` };
    }
    const cmd = 'rg --line-number ' + escapeShellArg(`\\b${sym}\\b`) + ' . --max-count 10';
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd });
    return { result: sanitizeToolOutput(`References to ${sym}:\n${output.slice(0, 2000)}`) };
  } catch { return { result: `Symbol "${args.symbol}" not found.` }; }
}

module.exports = { handleListProjects, handleGraphSearch, handleExplainSymbol };
