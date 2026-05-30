let _lspClient = null;
let _lspAttempted = false;

async function initLSP(options = {}) {
  if (_lspAttempted) return _lspClient;
  _lspAttempted = true;
  try {
    const { LSPClient } = require('../lsp/client');
    const client = new LSPClient(process.cwd());
    const ok = await client.start();
    if (ok) {
      _lspClient = client;
      if (options.fullscreenRef) options.fullscreenRef.addTool('lsp', 'ok', `${client.serverInfo.language} language server connected`);
    }
  } catch {}
  return _lspClient;
}

function getLspClient() {
  return _lspClient;
}

module.exports = { initLSP, getLspClient };
