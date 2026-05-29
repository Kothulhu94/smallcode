// SmallCode — Observability Dashboard CSS Styling (Milestone 7)
// Exports CSS styles for the dashboard to keep file sizes under 500 lines.

'use strict';

const CSS_CONTENT = `
:root {
  --bg: #0b0c10;
  --panel-bg: #1f2833;
  --border: #45a29e;
  --text: #c5c6c7;
  --text-highlight: #66fcf1;
  --text-muted: #858994;
  --success: #2ecc71;
  --error: #e74c3c;
  --warning: #f1c40f;
  --active: #1f2833;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
header {
  background: linear-gradient(135deg, #1f2833, #0b0c10);
  border-bottom: 1px solid rgba(102, 252, 241, 0.2);
  padding: 15px 30px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
h1 {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-highlight);
  display: flex;
  align-items: center;
  gap: 10px;
}
.stats-container {
  display: flex;
  gap: 20px;
}
.stat-card {
  background: rgba(31, 40, 51, 0.6);
  border: 1px solid rgba(102, 252, 241, 0.1);
  padding: 8px 15px;
  border-radius: 8px;
  text-align: center;
  min-width: 100px;
}
.stat-value {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-highlight);
}
.stat-label {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-transform: uppercase;
}
.refresh-btn {
  background: transparent;
  border: 1px solid var(--text-highlight);
  color: var(--text-highlight);
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}
.refresh-btn:hover {
  background: var(--text-highlight);
  color: var(--bg);
  box-shadow: 0 0 10px rgba(102, 252, 241, 0.3);
}
.main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.sidebar {
  width: 320px;
  border-right: 1px solid rgba(102, 252, 241, 0.15);
  background-color: rgba(31, 40, 51, 0.3);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.sidebar-header {
  padding: 15px;
  border-bottom: 1px solid rgba(102, 252, 241, 0.1);
  display: flex;
  gap: 10px;
}
.filter-select {
  background: var(--panel-bg);
  border: 1px solid rgba(102, 252, 241, 0.2);
  color: var(--text);
  padding: 6px;
  border-radius: 4px;
  flex: 1;
  outline: none;
}
.runs-list {
  flex: 1;
  overflow-y: auto;
}
.run-item {
  padding: 15px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: background-color 0.2s;
}
.run-item:hover {
  background-color: rgba(102, 252, 241, 0.05);
}
.run-item.active {
  background-color: rgba(102, 252, 241, 0.1);
  border-left: 3px solid var(--text-highlight);
}
.run-item-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: 0.85rem;
}
.badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.badge.completed { background: rgba(46, 204, 113, 0.2); color: var(--success); }
.badge.error { background: rgba(231, 76, 60, 0.2); color: var(--error); }
.badge.running { background: rgba(241, 196, 15, 0.2); color: var(--warning); }
.run-item-prompt {
  font-weight: 500;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 5px;
}
.run-item-footer {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.details-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--bg);
}
.placeholder-panel {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  flex: 1;
  color: var(--text-muted);
}
.placeholder-icon {
  font-size: 3rem;
  margin-bottom: 10px;
}
.run-header-detail {
  background-color: rgba(31, 40, 51, 0.4);
  border-bottom: 1px solid rgba(102, 252, 241, 0.1);
  padding: 20px 30px;
  flex-shrink: 0;
}
.run-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 15px;
}
.run-prompt-text {
  font-size: 1.25rem;
  font-weight: 600;
  color: #ffffff;
  max-width: 80%;
}
.run-meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 15px;
}
.meta-item {
  font-size: 0.85rem;
}
.meta-label {
  color: var(--text-muted);
  margin-bottom: 2px;
  text-transform: uppercase;
  font-size: 0.7rem;
  letter-spacing: 0.5px;
}
.meta-value {
  font-weight: 500;
  color: var(--text);
}
.tabs-bar {
  background-color: rgba(31, 40, 51, 0.8);
  border-bottom: 1px solid rgba(102, 252, 241, 0.1);
  display: flex;
  padding: 0 20px;
  flex-shrink: 0;
}
.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 12px 20px;
  cursor: pointer;
  font-weight: 500;
  font-size: 0.9rem;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.tab-btn:hover {
  color: var(--text);
}
.tab-btn.active {
  color: var(--text-highlight);
  border-bottom-color: var(--text-highlight);
}
.tab-contents {
  flex: 1;
  overflow-y: auto;
  padding: 30px;
}
.tab-content {
  display: none;
}
.tab-content.active {
  display: block;
}
.timeline {
  position: relative;
  padding-left: 20px;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(102, 252, 241, 0.15);
}
.timeline-item {
  position: relative;
  margin-bottom: 25px;
}
.timeline-item::before {
  content: '';
  position: absolute;
  left: -20px;
  top: 5px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-highlight);
  border: 2px solid var(--bg);
}
.timeline-item.error::before {
  background: var(--error);
}
.timeline-item-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: 0.9rem;
}
.timeline-type {
  font-weight: 600;
  color: var(--text-highlight);
  text-transform: uppercase;
  font-size: 0.8rem;
}
.timeline-time {
  color: var(--text-muted);
  font-size: 0.8rem;
}
.timeline-item-body {
  background: rgba(31, 40, 51, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 12px;
}
.timeline-summary {
  font-size: 0.9rem;
  line-height: 1.4;
  white-space: pre-wrap;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 10px;
  font-size: 0.85rem;
}
th, td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
th {
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.75rem;
}
tr:hover {
  background-color: rgba(255, 255, 255, 0.02);
}
pre {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  background: rgba(0, 0, 0, 0.3);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  max-width: 100%;
  white-space: pre-wrap;
}
`;

module.exports = {
  CSS_CONTENT
};
