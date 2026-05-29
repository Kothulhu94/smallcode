// SmallCode — Observability Dashboard UI Assets (Milestone 7)
// Exports the static HTML/CSS/JS page layout used by the observability dashboard.

'use strict';

const { CSS_CONTENT } = require('./dashboard_style');
const { JS_CONTENT } = require('./dashboard_client');

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SmallCode Observability Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${CSS_CONTENT}</style>
</head>
<body>
  <header>
    <h1>⚡ SmallCode Observability Dashboard</h1>
    <div class="stats-container" id="overview-stats">
      <div class="stat-card"><div class="stat-value" id="stat-total">0</div><div class="stat-label">Total Runs</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-rate">0%</div><div class="stat-label">Success Rate</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-duration">0s</div><div class="stat-label">Avg Duration</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-tokens">0</div><div class="stat-label">Total Tokens</div></div>
      <button class="refresh-btn" onclick="loadDashboard()">Refresh</button>
    </div>
  </header>

  <div class="main-layout">
    <div class="sidebar">
      <div class="sidebar-header">
        <select class="filter-select" id="filter-status" onchange="filterRuns()">
          <option value="all">All Statuses</option>
          <option value="completed">Completed</option>
          <option value="error">Error</option>
          <option value="running">Running</option>
        </select>
      </div>
      <div class="runs-list" id="runs-list-container">
        <!-- Runs will be populated here -->
      </div>
    </div>

    <div class="details-panel" id="details-panel-container">
      <div class="placeholder-panel" id="placeholder-view">
        <div class="placeholder-icon">🔍</div>
        <div>Select a run from the sidebar to inspect details</div>
      </div>
      <div class="details-content" id="details-view" style="display: none;">
        <div class="run-header-detail">
          <div class="run-title-row">
            <div class="run-prompt-text" id="detail-prompt">User Prompt</div>
            <span class="badge" id="detail-status">completed</span>
          </div>
          <div class="run-meta-grid">
            <div class="meta-item"><div class="meta-label">Run ID</div><div class="meta-value" id="detail-id">-</div></div>
            <div class="meta-item"><div class="meta-label">Task Type</div><div class="meta-value" id="detail-task-type">-</div></div>
            <div class="meta-item"><div class="meta-label">Active Agent</div><div class="meta-value" id="detail-agent">-</div></div>
            <div class="meta-item"><div class="meta-label">Model Preset</div><div class="meta-value" id="detail-model-preset">-</div></div>
            <div class="meta-item"><div class="meta-label">Tokens (P / C)</div><div class="meta-value" id="detail-tokens">-</div></div>
            <div class="meta-item"><div class="meta-label">Duration</div><div class="meta-value" id="detail-duration">-</div></div>
          </div>
        </div>

        <div class="tabs-bar">
          <button class="tab-btn active" onclick="showTab('tab-timeline')">Timeline & Steps</button>
          <button class="tab-btn" onclick="showTab('tab-tools')">Tool Calls</button>
          <button class="tab-btn" onclick="showTab('tab-auth')">Auth Events</button>
          <button class="tab-btn" onclick="showTab('tab-memory')">Memory Context</button>
        </div>

        <div class="tab-contents">
          <div class="tab-content active" id="tab-timeline">
            <div class="timeline" id="timeline-container">
              <!-- Steps populated here -->
            </div>
          </div>

          <div class="tab-content" id="tab-tools">
            <table>
              <thead>
                <tr>
                  <th>Tool Name</th>
                  <th>Arguments</th>
                  <th>Result Summary</th>
                  <th>Timing</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="tools-table-body">
                <!-- Tool calls populated here -->
              </tbody>
            </table>
          </div>

          <div class="tab-content" id="tab-auth">
            <table>
              <thead>
                <tr>
                  <th>Tool Name</th>
                  <th>Agent ID</th>
                  <th>Task Type</th>
                  <th>Enforcement Mode</th>
                  <th>Authorized</th>
                  <th>Reason/Warning</th>
                </tr>
              </thead>
              <tbody id="auth-table-body">
                <!-- Auth events populated here -->
              </tbody>
            </table>
          </div>

          <div class="tab-content" id="tab-memory">
            <table>
              <thead>
                <tr>
                  <th>Agent ID</th>
                  <th>Task Type</th>
                  <th>Budget Requested</th>
                  <th>Budget Resolved</th>
                  <th>Categories Allowed</th>
                  <th>Items Loaded</th>
                  <th>Tokens Used</th>
                </tr>
              </thead>
              <tbody id="memory-table-body">
                <!-- Memory events populated here -->
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>${JS_CONTENT}</script>
</body>
</html>
`;

module.exports = {
  HTML_CONTENT
};
