import type { CallMetrics, SystemStats } from './analytics';

export function renderDashboard(
  stats: SystemStats,
  activeCalls: CallMetrics[],
  recentCalls: CallMetrics[]
): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VOICE CONTROL // MONITORING STATION</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #00ff41;
      --warn: #ffb700;
      --error: #ff0040;
      --bg: #0a0a0a;
      --bg-alt: #141414;
      --text: #ffffff;
      --text-dim: #888888;
      --border: #333333;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    @keyframes scanline {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(100vh); }
    }

    @keyframes glitch {
      0%, 100% { transform: translate(0); }
      25% { transform: translate(-2px, 2px); }
      50% { transform: translate(2px, -2px); }
      75% { transform: translate(-1px, -1px); }
    }

    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 var(--primary); }
      50% { box-shadow: 0 0 0 8px transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes countUp {
      from { opacity: 0; transform: scale(0.5); }
      to { opacity: 1; transform: scale(1); }
    }

    body {
      font-family: 'IBM Plex Mono', monospace;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-image:
        repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px),
        repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px);
      pointer-events: none;
      z-index: 1;
    }

    body::after {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 3px;
      background: linear-gradient(90deg, transparent, var(--primary), transparent);
      animation: scanline 8s linear infinite;
      opacity: 0.3;
      pointer-events: none;
      z-index: 2;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 40px 30px;
      position: relative;
      z-index: 3;
    }

    header {
      margin-bottom: 40px;
      border-bottom: 2px solid var(--primary);
      padding-bottom: 20px;
      animation: fadeIn 0.6s ease;
    }

    h1 {
      font-family: 'Archivo Black', sans-serif;
      font-size: clamp(2rem, 5vw, 3.5rem);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 8px;
      background: linear-gradient(135deg, var(--text) 0%, var(--primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .status-line {
      font-size: 0.75rem;
      color: var(--text-dim);
      letter-spacing: 0.15em;
      text-transform: uppercase;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .status-indicator::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--primary);
      display: inline-block;
      animation: pulse-ring 2s infinite;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }

    .stat-card {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      padding: 24px;
      position: relative;
      animation: fadeIn 0.8s ease backwards;
      transition: border-color 0.3s;
    }

    .stat-card:nth-child(1) { animation-delay: 0.1s; }
    .stat-card:nth-child(2) { animation-delay: 0.15s; }
    .stat-card:nth-child(3) { animation-delay: 0.2s; }
    .stat-card:nth-child(4) { animation-delay: 0.25s; }
    .stat-card:nth-child(5) { animation-delay: 0.3s; }
    .stat-card:nth-child(6) { animation-delay: 0.35s; }

    .stat-card:hover {
      border-color: var(--primary);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: var(--primary);
    }

    .stat-card.warn::before { background: var(--warn); }
    .stat-card.error::before { background: var(--error); }

    .stat-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--text-dim);
      margin-bottom: 12px;
      font-weight: 500;
    }

    .stat-value {
      font-size: 3rem;
      font-weight: 700;
      line-height: 1;
      margin-bottom: 8px;
      color: var(--primary);
      animation: countUp 0.6s ease backwards;
      font-variant-numeric: tabular-nums;
    }

    .stat-sublabel {
      font-size: 0.7rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .section {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      padding: 30px;
      margin-bottom: 30px;
      position: relative;
      animation: fadeIn 1s ease backwards;
      animation-delay: 0.4s;
    }

    .section-header {
      font-family: 'Archivo Black', sans-serif;
      font-size: 1.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .live-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.7rem;
      color: var(--primary);
      animation: glitch 3s infinite;
    }

    .live-indicator::before {
      content: '';
      width: 12px;
      height: 12px;
      background: var(--primary);
      border-radius: 50%;
      animation: pulse-ring 1.5s infinite;
    }

    .call-item {
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-left: 3px solid var(--primary);
      padding: 20px;
      margin-bottom: 16px;
      font-size: 0.85rem;
      transition: all 0.3s;
    }

    .call-grid {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .call-item:hover {
      background: rgba(255,255,255,0.04);
      border-left-width: 6px;
    }

    .call-item.active {
      border-left-color: var(--primary);
      animation: pulse-ring 2s infinite;
    }

    .call-item.completed { border-left-color: #0088ff; }
    .call-item.failed { border-left-color: var(--error); }
    .call-item.transferred { border-left-color: var(--warn); }

    .call-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .call-id {
      font-weight: 700;
      font-size: 1rem;
      letter-spacing: 0.05em;
    }

    .badge {
      background: var(--border);
      padding: 4px 12px;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
    }

    .badge.active { background: var(--primary); color: var(--bg); }
    .badge.completed { background: #0088ff; }
    .badge.failed { background: var(--error); }
    .badge.transferred { background: var(--warn); color: var(--bg); }

    .call-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      font-size: 0.75rem;
      color: var(--text-dim);
      margin-bottom: 12px;
    }

    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .meta-label {
      color: var(--text-dim);
      text-transform: uppercase;
      font-size: 0.65rem;
      letter-spacing: 0.1em;
    }

    .meta-value {
      color: var(--text);
      font-weight: 600;
    }

    .sentiment-positive { color: var(--primary); }
    .sentiment-negative { color: var(--error); }
    .sentiment-neutral { color: var(--warn); }

    .view-transcript-btn {
      background: transparent;
      border: 1px solid var(--primary);
      color: var(--primary);
      padding: 8px 20px;
      cursor: pointer;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
      transition: all 0.3s;
      margin-top: 8px;
    }

    .view-transcript-btn:hover {
      background: var(--primary);
      color: var(--bg);
      box-shadow: 0 0 20px rgba(0, 255, 65, 0.3);
    }

    .tool-bar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .tool-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }

    .tool-name {
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .tool-count {
      font-weight: 700;
      color: var(--primary);
      font-size: 1.2rem;
      min-width: 40px;
      text-align: right;
    }

    .tool-bar-bg {
      flex: 1;
      height: 6px;
      background: var(--border);
      position: relative;
      overflow: hidden;
    }

    .tool-bar-fill {
      height: 100%;
      background: var(--primary);
      transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 0 10px var(--primary);
    }

    .refresh-btn {
      position: fixed;
      bottom: 30px;
      right: 30px;
      background: var(--primary);
      color: var(--bg);
      border: none;
      padding: 16px 32px;
      cursor: pointer;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      font-weight: 700;
      transition: all 0.3s;
      box-shadow: 0 4px 20px rgba(0, 255, 65, 0.3);
      z-index: 100;
    }

    .refresh-btn:hover {
      background: var(--text);
      box-shadow: 0 6px 30px rgba(0, 255, 65, 0.5);
      transform: translateY(-2px);
    }

    .refresh-btn:active {
      transform: translateY(0);
    }

    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.95);
      z-index: 1000;
      padding: 40px;
      overflow-y: auto;
    }

    .modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-content {
      background: var(--bg-alt);
      border: 2px solid var(--primary);
      padding: 40px;
      max-width: 900px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      position: relative;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid var(--border);
    }

    .modal-title {
      font-family: 'Archivo Black', sans-serif;
      font-size: 1.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .close-btn {
      background: transparent;
      border: 1px solid var(--error);
      color: var(--error);
      padding: 10px 20px;
      cursor: pointer;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 600;
      transition: all 0.3s;
    }

    .close-btn:hover {
      background: var(--error);
      color: var(--text);
    }

    .transcript-entry {
      margin-bottom: 20px;
      padding: 20px;
      background: rgba(255,255,255,0.02);
      border-left: 3px solid var(--primary);
      position: relative;
    }

    .transcript-entry.assistant {
      border-left-color: #0088ff;
    }

    .transcript-speaker {
      font-weight: 700;
      margin-bottom: 10px;
      text-transform: uppercase;
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      color: var(--primary);
    }

    .transcript-entry.assistant .transcript-speaker {
      color: #0088ff;
    }

    .transcript-text {
      font-size: 0.9rem;
      line-height: 1.6;
      margin-bottom: 10px;
    }

    .transcript-time {
      font-size: 0.65rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-dim);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    @media (max-width: 768px) {
      .container { padding: 20px 16px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .stat-value { font-size: 2rem; }
      .section { padding: 20px; }
      .call-meta { grid-template-columns: 1fr; }
      .refresh-btn { bottom: 20px; right: 20px; padding: 12px 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Voice Control Monitor</h1>
      <div class="status-line">
        <div class="status-indicator">System Active</div>
        <div>Azure OpenAI Realtime</div>
        <div>Auto-Refresh: 5s</div>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Active Calls</div>
        <div class="stat-value" data-stat="active">${stats.activeCalls}</div>
        <div class="stat-sublabel">In Progress</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Sessions</div>
        <div class="stat-value" data-stat="total">${stats.totalCalls}</div>
        <div class="stat-sublabel">All Time</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value" data-stat="completed">${stats.completedCalls}</div>
        <div class="stat-sublabel">Successful</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tool Calls</div>
        <div class="stat-value" data-stat="tools">${stats.totalToolCalls}</div>
        <div class="stat-sublabel">Executed</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Duration</div>
        <div class="stat-value" data-stat="avgDuration">${Math.round(stats.averageCallDuration / 1000)}s</div>
        <div class="stat-sublabel">Per Call</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Latency</div>
        <div class="stat-value" data-stat="avgLatency">${Math.round(stats.averageLatencyMs)}ms</div>
        <div class="stat-sublabel">User → Reply</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">System Uptime</div>
        <div class="stat-value" data-stat="uptimeHours">${Math.floor(stats.uptime / (1000 * 60 * 60))}h</div>
        <div class="stat-sublabel" data-stat="uptimeMinutes">${Math.floor((stats.uptime % (1000 * 60 * 60)) / (1000 * 60))}m</div>
      </div>
    </div>

    <div class="section" id="active-calls-section">
      <div class="section-header">
        <span>Active Calls</span>
        <div class="live-indicator">LIVE</div>
      </div>
      <div class="call-grid" id="active-call-grid">
        ${
          activeCalls.length === 0
            ? '<div class="empty-state">No active calls</div>'
            : activeCalls
                .map(
                  (call) => `
          <div class="call-item active">
            <div class="call-header">
              <span class="call-id">CALL_${call.callId.slice(0, 8).toUpperCase()}</span>
              <span class="badge active">ACTIVE</span>
            </div>
            <div class="call-meta">
              ${
                call.metadata.callerPhone
                  ? `<div class="meta-item">
                <span class="meta-label">📞 Caller:</span>
                <span class="meta-value">${call.metadata.callerPhone}</span>
              </div>`
                  : ''
              }
              <div class="meta-item">
                <span class="meta-label">Duration:</span>
                <span class="meta-value">${Math.floor((Date.now() - call.startTime) / 1000)}s</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Tools:</span>
                <span class="meta-value">${call.toolCalls.length}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Messages:</span>
                <span class="meta-value">${call.transcripts.length}</span>
              </div>
              ${
                call.sentiment
                  ? `
              <div class="meta-item">
                <span class="meta-label">Sentiment:</span>
                <span class="meta-value sentiment-${call.sentiment}">${call.sentiment.toUpperCase()}</span>
              </div>
              `
                  : ''
              }
            </div>
          </div>
        `
                )
                .join('')
        }
      </div>
    </div>

    <div class="section" id="recent-calls-section">
      <div class="section-header">Recent Activity</div>
      <div class="call-grid" id="recent-call-grid">
        ${
          recentCalls.length === 0
            ? '<div class="empty-state">No calls recorded yet</div>'
            : recentCalls
                .map(
                  (call) => `
        <div class="call-item ${call.status}">
          <div class="call-header">
            <span class="call-id">CALL_${call.callId.slice(0, 8).toUpperCase()}</span>
            <span class="badge ${call.status}">${call.status.toUpperCase()}</span>
          </div>
          <div class="call-meta">
            ${
              call.metadata.callerPhone
                ? `<div class="meta-item">
              <span class="meta-label">📞 Caller:</span>
              <span class="meta-value">${call.metadata.callerPhone}</span>
            </div>`
                : ''
            }
            <div class="meta-item">
              <span class="meta-label">Duration:</span>
              <span class="meta-value">${call.duration ? `${Math.floor(call.duration / 1000)}s` : 'N/A'}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Tools:</span>
              <span class="meta-value">${call.toolCalls.map((t) => t.name).join(', ') || 'none'}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Messages:</span>
              <span class="meta-value">${call.transcripts.length}</span>
            </div>
            ${
              call.sentiment
                ? `
            <div class="meta-item">
              <span class="meta-label">Sentiment:</span>
              <span class="meta-value sentiment-${call.sentiment}">${call.sentiment.toUpperCase()}</span>
            </div>
            `
                : ''
            }
          </div>
          ${
            call.transcripts.length > 0
              ? `
          <button class="view-transcript-btn" onclick="showTranscript('${call.callId}')">
            View Transcript
          </button>
          `
              : ''
          }
        </div>
      `
                )
                .join('')
        }
      </div>
    </div>

    <div class="section" id="tool-usage-section">
      <div class="section-header">Tool Usage Stats</div>
      ${
        Object.entries(stats.toolCallsByType).length === 0
          ? '<div class="empty-state">No tools used yet</div>'
          : `<div class="tool-bar">${Object.entries(stats.toolCallsByType)
              .map(
                ([tool, count]) => `
          <div class="tool-item">
            <span class="tool-name">${tool}</span>
            <div class="tool-bar-bg">
              <div class="tool-bar-fill" style="width: ${(count / stats.totalToolCalls) * 100}%"></div>
            </div>
            <span class="tool-count">${count}</span>
          </div>
        `
              )
              .join('')}</div>`
      }
    </div>
  </div>

  <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>

  <div id="transcriptModal" class="modal" onclick="closeModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2 class="modal-title" id="modalTitle">Transcript</h2>
        <button class="close-btn" onclick="closeModal()">× Close</button>
      </div>
      <div id="transcriptContent">
        <div class="empty-state">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    async function showTranscript(callId) {
      const modal = document.getElementById('transcriptModal');
      const content = document.getElementById('transcriptContent');
      const title = document.getElementById('modalTitle');

      modal.classList.add('active');
      content.innerHTML = '<div class="empty-state">Loading transcript...</div>';
      title.textContent = 'Transcript // Call ' + callId.slice(0, 8).toUpperCase();

      try {
        const response = await fetch('/api/calls/' + callId + '/transcript');
        const data = await response.json();

        if (data.error) {
          content.innerHTML = '<div class="empty-state" style="color: var(--error);">Transcript not available</div>';
          return;
        }

        if (data.transcript.length === 0) {
          content.innerHTML = '<div class="empty-state">No messages recorded</div>';
          return;
        }

        content.innerHTML = data.transcript.map(entry => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const speakerClass = entry.speaker === 'assistant' ? 'assistant' : 'user';
          const speakerLabel = entry.speaker === 'user' ? 'User' : 'Assistant';

          return \`
            <div class="transcript-entry \${speakerClass}">
              <div class="transcript-speaker">\${speakerLabel}</div>
              <div class="transcript-text">\${entry.text}</div>
              <div class="transcript-time">\${time}\${entry.sentiment ? ' • ' + entry.sentiment.toUpperCase() : ''}</div>
            </div>
          \`;
        }).join('');
      } catch (error) {
        content.innerHTML = '<div class="empty-state" style="color: var(--error);">Error loading transcript</div>';
      }
    }

    function closeModal(event) {
      if (!event || event.target.id === 'transcriptModal') {
        document.getElementById('transcriptModal').classList.remove('active');
      }
    }

    // Live updates via SSE - no auto-refresh!
    const eventSource = new EventSource('/api/events');

    eventSource.onmessage = (event) => {
      try {
        const { stats, activeCalls, recentCalls } = JSON.parse(event.data);

        const setStat = (key, value) => {
          const el = document.querySelector('[data-stat="' + key + '"]');
          if (el) {
            el.textContent = value;
          }
        };

        setStat('active', stats.activeCalls);
        setStat('total', stats.totalCalls);
        setStat('completed', stats.completedCalls);
        setStat('tools', stats.totalToolCalls);
        setStat('avgDuration', Math.round(stats.averageCallDuration / 1000) + 's');
        setStat('avgLatency', Math.round(stats.averageLatencyMs) + 'ms');
        setStat('uptimeHours', Math.floor(stats.uptime / (1000 * 60 * 60)) + 'h');
        setStat(
          'uptimeMinutes',
          Math.floor((stats.uptime % (1000 * 60 * 60)) / (1000 * 60)) + 'm'
        );

        // Update active calls section
        const activeCallsSection = document.getElementById('active-call-grid');
        if (activeCallsSection) {
          activeCallsSection.innerHTML = activeCalls.length === 0
            ? '<div class="empty-state">No active calls</div>'
            : activeCalls.map(call => \`
              <div class="call-item active">
                <div class="call-header">
                  <span class="call-id">CALL_\${call.callId.slice(0, 8).toUpperCase()}</span>
                  <span class="badge active">ACTIVE</span>
                </div>
                <div class="call-meta">
                  \${call.metadata.callerPhone ? \`<div class="meta-item">
                    <span class="meta-label">📞 Caller:</span>
                    <span class="meta-value">\${call.metadata.callerPhone}</span>
                  </div>\` : ''}
                  <div class="meta-item">
                    <span class="meta-label">Duration:</span>
                    <span class="meta-value">\${Math.floor((Date.now() - call.startTime) / 1000)}s</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Tools:</span>
                    <span class="meta-value">\${call.toolCalls.length}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Messages:</span>
                    <span class="meta-value">\${call.transcripts.length}</span>
                  </div>
                  \${call.sentiment ? \`<div class="meta-item">
                    <span class="meta-label">Sentiment:</span>
                    <span class="meta-value sentiment-\${call.sentiment}">\${call.sentiment.toUpperCase()}</span>
                  </div>\` : ''}
                </div>
              </div>
            \`).join('');
        }

        // Update recent activity section
        const recentActivitySection = document.getElementById('recent-call-grid');
        if (recentActivitySection) {
          recentActivitySection.innerHTML = recentCalls.length === 0
            ? '<div class="empty-state">No recent calls</div>'
            : recentCalls.map(call => \`
              <div class="call-item \${call.status}">
                <div class="call-header">
                  <span class="call-id">CALL_\${call.callId.slice(0, 8).toUpperCase()}</span>
                  <span class="badge \${call.status}">\${call.status.toUpperCase()}</span>
                </div>
                <div class="call-meta">
                  \${call.metadata.callerPhone ? \`<div class="meta-item">
                    <span class="meta-label">📞 Caller:</span>
                    <span class="meta-value">\${call.metadata.callerPhone}</span>
                  </div>\` : ''}
                  <div class="meta-item">
                    <span class="meta-label">Duration:</span>
                    <span class="meta-value">\${call.duration ? Math.floor(call.duration / 1000) + 's' : 'N/A'}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Tools:</span>
                    <span class="meta-value">\${call.toolCalls.map(t => t.name).join(', ') || 'none'}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Messages:</span>
                    <span class="meta-value">\${call.transcripts.length}</span>
                  </div>
                  \${call.sentiment ? \`<div class="meta-item">
                    <span class="meta-label">Sentiment:</span>
                    <span class="meta-value sentiment-\${call.sentiment}">\${call.sentiment.toUpperCase()}</span>
                  </div>\` : ''}
                </div>
                \${call.transcripts.length > 0 ? \`
                <button class="view-transcript-btn" onclick="showTranscript('\${call.callId}')">
                  View Transcript
                </button>
                \` : ''}
              </div>
            \`).join('');
        }

        // Update tool usage stats section

        const toolStatsSection = document.getElementById('tool-usage-section');
        if (toolStatsSection) {
          const toolEntries = Object.entries(stats.toolCallsByType || {});
          const toolContent = toolEntries.length === 0
            ? '<div class="empty-state">No tools used yet</div>'
            : '<div class="tool-bar">' +
              toolEntries
                .map(
                  ([tool, count]) =>
                    '<div class="tool-item">' +
                    '<span class="tool-name">' + tool + '</span>' +
                    '<div class="tool-bar-bg">' +
                    '<div class="tool-bar-fill" style="width: ' + (count / stats.totalToolCalls) * 100 + '%"></div>' +
                    '</div>' +
                    '<span class="tool-count">' + count + '</span>' +
                    '</div>'
                )
                .join('') +
              '</div>';

          toolStatsSection.innerHTML = '<div class="section-header">Tool Usage Stats</div>' + toolContent;
        }

      } catch (e) {
        console.error('Failed to update dashboard:', e);
      }
    };

    eventSource.onerror = () => {
      console.warn('SSE connection lost');
    };
  </script>
</body>
</html>`;
}
