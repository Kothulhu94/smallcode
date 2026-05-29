// SmallCode — Observability Dashboard Frontend JS Client (Milestone 7)
// Exports frontend Javascript logic for dynamic operations in the dashboard.

'use strict';

const JS_CONTENT = `
let allRuns = [];
let selectedRunId = null;

async function loadDashboard() {
  try {
    const statsResp = await fetch('/api/stats');
    const stats = await statsResp.json();
    updateStats(stats);

    const runsResp = await fetch('/api/runs');
    allRuns = await runsResp.json();
    renderRunsList(allRuns);

    if (selectedRunId) {
      loadRunDetail(selectedRunId);
    }
  } catch (e) {
    console.error('Failed to load dashboard metrics:', e);
  }
}

function updateStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalRuns || 0;
  const rate = stats.totalRuns ? Math.round((stats.successCount / stats.totalRuns) * 100) : 0;
  document.getElementById('stat-rate').textContent = rate + '%';
  document.getElementById('stat-duration').textContent = ((stats.avgDurationMs || 0) / 1000).toFixed(1) + 's';
  document.getElementById('stat-tokens').textContent = (stats.totalPromptTokens + stats.totalCompletionTokens || 0).toLocaleString();
}

function renderRunsList(runs) {
  const container = document.getElementById('runs-list-container');
  container.innerHTML = '';

  if (runs.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No runs found</div>';
    return;
  }

  runs.forEach(run => {
    const item = document.createElement('div');
    item.className = 'run-item' + (run.id === selectedRunId ? ' active' : '');
    item.onclick = () => selectRun(run.id);

    const timeStr = new Date(run.started_at).toLocaleTimeString();
    item.innerHTML = \`
      <div class="run-item-header">
        <span>\${run.agent_id || 'conductor'}</span>
        <span class="badge \${run.status}">\${run.status}</span>
      </div>
      <div class="run-item-prompt">\${escapeHtml(run.prompt || 'No Prompt')}</div>
      <div class="run-item-footer">
        <span>\${timeStr}</span>
        <span>\${((run.duration_ms || 0) / 1000).toFixed(1)}s</span>
      </div>
    \`;
    container.appendChild(item);
  });
}

function filterRuns() {
  const filter = document.getElementById('filter-status').value;
  if (filter === 'all') {
    renderRunsList(allRuns);
  } else {
    renderRunsList(allRuns.filter(r => r.status === filter));
  }
}

async function selectRun(runId) {
  selectedRunId = runId;
  document.querySelectorAll('.run-item').forEach(el => el.classList.remove('active'));
  loadRunDetail(runId);
  loadDashboard();
}

async function loadRunDetail(runId) {
  try {
    const resp = await fetch('/api/runs/' + runId);
    if (!resp.ok) return;
    const run = await resp.json();

    document.getElementById('placeholder-view').style.display = 'none';
    const detailsView = document.getElementById('details-view');
    detailsView.style.display = 'block';

    document.getElementById('detail-prompt').textContent = run.prompt || 'No Prompt';
    document.getElementById('detail-id').textContent = run.id;
    document.getElementById('detail-task-type').textContent = run.task_type || '-';
    document.getElementById('detail-agent').textContent = run.agent_id || 'conductor';
    document.getElementById('detail-model-preset').textContent = run.model_preset || '-';
    document.getElementById('detail-tokens').textContent = \`\${run.prompt_tokens || 0} / \${run.completion_tokens || 0}\`;
    document.getElementById('detail-duration').textContent = ((run.duration_ms || 0) / 1000).toFixed(1) + 's';
    
    const statusBadge = document.getElementById('detail-status');
    statusBadge.className = 'badge ' + run.status;
    statusBadge.textContent = run.status;

    renderTimeline(run.steps || []);
    renderToolsTable(run.toolCalls || []);
    renderAuthTable(run.authEvents || []);
    renderMemoryTable(run.memEvents || []);
  } catch (e) {
    console.error('Failed to load run detail:', e);
  }
}

function renderTimeline(steps) {
  const container = document.getElementById('timeline-container');
  container.innerHTML = '';

  if (steps.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); padding: 10px;">No timeline steps recorded.</div>';
    return;
  }

  steps.forEach(step => {
    const item = document.createElement('div');
    item.className = 'timeline-item' + (step.success === 0 ? ' error' : '');
    item.innerHTML = \`
      <div class="timeline-item-header">
        <span class="timeline-type">\${step.step_type} \${step.name ? '— ' + step.name : ''}</span>
        <span class="timeline-time">\${((step.duration_ms || 0) / 1000).toFixed(2)}s</span>
      </div>
      <div class="timeline-item-body">
        <div class="timeline-summary">\${escapeHtml(step.summary || '')}</div>
      </div>
    \`;
    container.appendChild(item);
  });
}

function renderToolsTable(tools) {
  const tbody = document.getElementById('tools-table-body');
  tbody.innerHTML = '';

  if (tools.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">No tool calls executed.</td></tr>';
    return;
  }

  tools.forEach(tc => {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td style="font-weight: 600; color: var(--text-highlight);">\${tc.tool_name}</td>
      <td><pre>\${escapeHtml(formatArgs(tc.args_json))}</pre></td>
      <td>\${escapeHtml(tc.result_summary || '')}</td>
      <td>\${tc.duration_ms ? tc.duration_ms + 'ms' : '-'}</td>
      <td><span class="badge \${tc.success ? 'completed' : 'error'}">\${tc.success ? 'success' : 'failed'}</span></td>
    \`;
    tbody.appendChild(row);
  });
}

function renderAuthTable(auths) {
  const tbody = document.getElementById('auth-table-body');
  tbody.innerHTML = '';

  if (auths.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No tool authorizations recorded.</td></tr>';
    return;
  }

  auths.forEach(auth => {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td style="font-weight: 500;">\${auth.tool_name}</td>
      <td>\${auth.agent_id || '-'}</td>
      <td>\${auth.task_type || '-'}</td>
      <td>\${auth.mode || 'warn'}</td>
      <td><span class="badge \${auth.authorized ? 'completed' : 'error'}">\${auth.authorized ? 'allow' : 'deny'}</span></td>
      <td>\${escapeHtml(auth.reason || '')}</td>
    \`;
    tbody.appendChild(row);
  });
}

function renderMemoryTable(mems) {
  const tbody = document.getElementById('memory-table-body');
  tbody.innerHTML = '';

  if (mems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No memory queries recorded.</td></tr>';
    return;
  }

  mems.forEach(mem => {
    const row = document.createElement('tr');
    row.innerHTML = \`
      <td>\${mem.agent_id || '-'}</td>
      <td>\${mem.task_type || '-'}</td>
      <td>\${mem.budget_requested || '-'}</td>
      <td>\${mem.budget_resolved || '-'}</td>
      <td>\${escapeHtml(mem.categories_allowed || '')}</td>
      <td>\${mem.items_loaded || 0}</td>
      <td>\${mem.tokens_used || 0}</td>
    \`;
    tbody.appendChild(row);
  });
}

function showTab(evt, tabName) {
  // If called as showTab('tab-name') without event, shift arguments or check window.event
  let actualTab = tabName;
  let eventObj = evt;
  if (typeof evt === 'string') {
    actualTab = evt;
    eventObj = window.event;
  }

  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  
  const tabEl = document.getElementById(actualTab);
  if (tabEl) tabEl.classList.add('active');

  const target = (eventObj && eventObj.target) || (window.event && window.event.target);
  if (target) {
    target.classList.add('active');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatArgs(argsJson) {
  if (!argsJson) return '{}';
  try {
    const parsed = JSON.parse(argsJson);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return argsJson;
  }
}

// Initial Load
loadDashboard();

// Auto-refresh every 3 seconds
setInterval(loadDashboard, 3000);
`;

module.exports = {
  JS_CONTENT
};
