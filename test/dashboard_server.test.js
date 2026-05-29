// Milestone 7 — Observability Dashboard Server Unit Tests
//
// Verifies:
// 1. startDashboardServer spins up on a free port (0).
// 2. GET / returns HTML dashboard.
// 3. GET /api/runs returns a list of recent runs as JSON.
// 4. GET /api/stats returns aggregate metrics as JSON.
// 5. GET /api/runs/:id returns details of a single run as JSON.
// 6. Server closes cleanly without leaving dangling resources.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { startDashboardServer } = require('../src/governor/dashboard_server');
const { getLedger, resetLedger } = require('../src/governor/run_ledger');

test('Milestone 7 - Dashboard Server REST API', async (t) => {
  resetLedger();
  const ledger = getLedger({ dbPath: ':memory:' });
  ledger.init();

  const runId = ledger.startRun({
    prompt: 'Dashboard Test Prompt',
    model: 'gemma-4',
    taskType: 'coding',
    agentId: 'code_editor',
    modelPreset: 'default'
  });
  ledger.recordStep({ runId, stepIndex: 0, stepType: 'model_response', name: 'gemma-4', durationMs: 50, success: true, summary: 'Done' });
  ledger.endRun(runId, { status: 'completed', promptTokens: 10, completionTokens: 20 });

  const server = startDashboardServer(0);
  
  const port = await new Promise((resolve) => {
    server.on('listening', () => {
      resolve(server.address().port);
    });
  });

  const getUrl = (path) => `http://localhost:${port}${path}`;

  const request = (path) => new Promise((resolve, reject) => {
    http.get(getUrl(path), (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });

  await t.test('GET / returns HTML dashboard', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('SmallCode Observability Dashboard'));
  });

  await t.test('GET /api/runs returns list of runs', async () => {
    const res = await request('/api/runs');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    
    const runs = JSON.parse(res.body);
    assert.ok(Array.isArray(runs));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, runId);
    assert.equal(runs[0].prompt, 'Dashboard Test Prompt');
  });

  await t.test('GET /api/stats returns stats aggregation', async () => {
    const res = await request('/api/stats');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    
    const stats = JSON.parse(res.body);
    assert.equal(stats.totalRuns, 1);
    assert.equal(stats.successCount, 1);
    assert.equal(stats.totalPromptTokens, 10);
    assert.equal(stats.totalCompletionTokens, 20);
  });

  await t.test('GET /api/runs/:id returns run details and events', async () => {
    const res = await request(`/api/runs/${runId}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    
    const run = JSON.parse(res.body);
    assert.equal(run.id, runId);
    assert.equal(run.prompt, 'Dashboard Test Prompt');
    assert.ok(Array.isArray(run.steps));
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].summary, 'Done');
  });

  await t.test('GET /api/runs/:id returns 404 for missing run', async () => {
    const res = await request('/api/runs/nonexistent');
    assert.equal(res.status, 404);
    const error = JSON.parse(res.body);
    assert.ok(error.error.includes('not found'));
  });

  await new Promise((resolve) => {
    server.close(resolve);
  });
  
  ledger.close();
  resetLedger();
});
