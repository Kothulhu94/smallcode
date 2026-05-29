// SmallCode — Observability Dashboard Server (Milestone 7)
// Exposes a native Node.js HTTP server serving a single-page HTML/CSS/JS
// dashboard to audit and inspect agent execution logs from the run ledger.

'use strict';

const http = require('http');
const url = require('url');
const { getLedger } = require('./run_ledger');
const { HTML_CONTENT } = require('./dashboard_assets');

/**
 * Start the native Node.js HTTP server.
 * @param {number} port
 * @param {object} [options={}]
 * @returns {http.Server}
 */
function startDashboardServer(port, options = {}) {
  const ledger = getLedger();
  
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // CORS Headers for dynamic external developer access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route: GET /
    if (pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_CONTENT);
      return;
    }

    // Route: GET /api/runs
    if (pathname === '/api/runs' && method === 'GET') {
      try {
        const runs = ledger.listRuns({ limit: 50 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(runs));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Route: GET /api/stats
    if (pathname === '/api/stats' && method === 'GET') {
      try {
        const stats = ledger.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Route: GET /api/runs/:id
    const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)$/);
    if (runMatch && method === 'GET') {
      const runId = runMatch[1];
      try {
        const runDetail = ledger.getRunDetail(runId);
        if (!runDetail) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Run ${runId} not found` }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(runDetail));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // 404 Route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route not found' }));
  });

  server.on('error', (err) => {
    console.error(`\n  ✗ Dashboard server error: ${err.message}`);
  });

  server.listen(port);
  return server;
}

// Command-line entrypoint support
if (require.main === module) {
  const requestedPort = process.argv[2] ? parseInt(process.argv[2], 10) : 3000;
  const port = isNaN(requestedPort) ? 3000 : requestedPort;
  try {
    const server = startDashboardServer(port);
    console.log(`\n  ⚡ SmallCode Observability Dashboard running at http://localhost:${port}\n`);
    
    // Graceful Shutdown Hook
    process.on('SIGINT', () => {
      server.close(() => {
        console.log('  Dashboard server stopped.');
        process.exit(0);
      });
    });
  } catch (e) {
    console.error(`Failed to start dashboard server: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  startDashboardServer
};
