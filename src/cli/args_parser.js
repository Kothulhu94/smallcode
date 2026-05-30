const VERSION = require('../../package.json').version;
const LOGO = `
  ⚡ SmallCode v${VERSION}
  AI coding agent for small LLMs
`;

function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '--version') flags.version = true;
    else if (arg === '-V' || arg === '--verbose') flags.verbose = true;
    else if (arg === '-v') flags.version = true;
    else if (arg === '-r' || arg === '--resume') flags.resume = true;
    else if (arg === '--mcp') flags.mcp = true;
    else if (arg === '--acp') flags.acp = true;
    else if (arg === '--init' || arg === 'init') flags.init = true;
    else if (arg === '--non-interactive') flags.nonInteractive = true;
    else if (arg === '--classic') flags.classic = true;
    else if (arg === '-m' || arg === '--model') { flags.model = args[++i]; }
    else if (arg === '-p' || arg === '--provider') { flags.provider = args[++i]; }
    else if (arg === '--endpoint' || arg === '--base-url') { flags.endpoint = args[++i]; }
    else if (arg === '-P' || arg === '--prompt') { flags.prompt = args[++i]; }
    else if (arg === '--eval') { flags.eval = args[++i] || 'classify_accuracy'; }
    else if (arg === '--trace') { flags.trace = args[++i]; }
    else positional.push(arg);
  }

  return { flags, positional };
}

function handleQuickExits(flags) {
  if (flags.version) {
    console.log(`smallcode v${VERSION}`);
    process.exit(0);
  }

  if (flags.help) {
    console.log(`${LOGO}
USAGE:
  smallcode [OPTIONS] [PROMPT]

OPTIONS:
  -h, --help              Show this help
  -v, --version           Show version
  -V, --verbose           Verbose output (show tool I/O)
  -m, --model <NAME>      Model to use (default: qwen2.5-coder:14b)
  -p, --provider <NAME>   Provider (ollama, openai, anthropic, llamacpp)
  --endpoint <URL>        OpenAI-compatible endpoint/base URL
  -P, --prompt <TEXT>     Run a single prompt non-interactively
  -r, --resume            Resume last active session
  --non-interactive       Run single prompt, no TUI
  --classic             Use classic readline TUI (no alternate screen)
  --mcp                   Run as MCP server (JSON-RPC over stdio)
  --eval <SUITE>          Run prompt evaluation suite
  --trace <ID>            Replay a recorded trace

COMMANDS (in TUI):
  /quit, /q       Exit
  /clear          Reset conversation
  /stats          Session statistics
  /memory         Show working memory
  /plan           Show task plan
  /undo           Revert last edit
  /sessions       List saved sessions
  /save           Save session
  /eval           Run prompt evaluation
  /budget         Show token budget
  /help           All commands

EXAMPLES:
  smallcode                                Start interactive TUI
  smallcode "fix the bug in main.ts"       Single prompt
  smallcode -m qwen3:8b                    Use specific model
  smallcode --resume                       Continue last session
  smallcode --mcp                          Start as MCP server
  echo "refactor" | smallcode --non-interactive
`);
    process.exit(0);
  }
}

module.exports = {
  parseArgs,
  handleQuickExits,
  VERSION,
  LOGO
};
