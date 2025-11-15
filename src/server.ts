import { serve } from "bun";
import { Hono } from "hono";
import OpenAI from "openai";
import WebSocket from "ws";
import { analytics } from "./analytics";
import { acceptCall, type RealtimeSessionConfig } from "./callflow";
import { config } from "./config";
import { logger } from "./logger";
import { logCallLifecycle, logTranscript, logWebhook } from "./observe";
import { greetingPrompt, systemPrompt } from "./prompts";
import { realtimeToolSchemas, runTool } from "./tools";

type PendingToolCall = {
  name: string;
  argsBuffer: string;
};

type CallSession = {
  callId: string;
  ws: WebSocket;
  pendingTools: Map<string, PendingToolCall>;
  activeResponses: Set<string>;
  configured: boolean;
  greeted: boolean;
  toolsUnlocked: boolean;
  responseGateUntil: number;
  pendingTurnTimer?: ReturnType<typeof setTimeout>;
  minGapMs: number;
  userSpeaking: boolean;
  heardUser: boolean;
  bargeGuardUntil: number;
  pendingFollowUps: ResponseRequest[];
};

type RealtimeEventHandler = (
  session: CallSession,
  event: Record<string, unknown>
) => Promise<void> | void;

export const app = new Hono();
const openai = new OpenAI({
  apiKey: config.apiKey,
  baseURL: config.openaiBaseUrl,
  webhookSecret: config.webhookSecret,
});

const sessions = new Map<string, CallSession>();
const TRAILING_SLASH_REGEX = /\/$/;
const V1_REALTIME_REGEX = /\/v1\/realtime$/;
const REALTIME_SUFFIX_REGEX = /\/realtime$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const truncate = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const describeRealtimeEvent = (
  event: Record<string, unknown>
): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    type: getString(event.type) ?? "unknown",
  };

  const response = isRecord(event.response) ? event.response : undefined;
  if (response) {
    summary.responseId = getString(response.id);
    summary.responseStatus = getString(response.status);
  }

  const item = isRecord(event.item) ? event.item : undefined;
  if (item) {
    summary.itemId = getString(item.id);
    summary.itemType = getString(item.type);
    summary.itemRole = getString(item.role);
  }

  const delta = getString(event.delta);
  if (delta) {
    summary.delta = truncate(delta, 120);
  }

  const transcript = getString(event.transcript);
  if (transcript) {
    summary.transcript = truncate(transcript, 120);
  }

  const argumentsJson = getString(event.arguments);
  if (argumentsJson) {
    summary.arguments = truncate(argumentsJson, 120);
  }

  const error = isRecord(event.error) ? event.error : undefined;
  if (error) {
    const errorMessage = getString(error?.message);
    summary.error = {
      type: getString(error.type),
      code: getString(error.code),
      message: truncate(errorMessage ?? "", 120),
    };
  }

  return summary;
};

function logResponseTextDelta(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const delta = getString(event.delta);
  if (delta) {
    logCallLifecycle(session.callId, "response_text_delta", {
      text: truncate(delta, 160),
    });
  }
}

function logResponseAudioDelta(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const chunk = getString(event.delta);
  if (chunk) {
    logCallLifecycle(session.callId, "response_audio_chunk", {
      bytes: chunk.length,
    });
  }
}

function handleSpeechStarted(session: CallSession): void {
  session.userSpeaking = true;
  logCallLifecycle(session.callId, "speech_detected", { phase: "start" });
  analytics.recordSpeechEvent(session.callId);

  if (!session.toolsUnlocked && Date.now() < session.bargeGuardUntil) {
    logCallLifecycle(session.callId, "barge_guard_active", {
      remainingMs: session.bargeGuardUntil - Date.now(),
    });
    return;
  }
  cancelActiveResponses(session);
  analytics.recordBargeIn(session.callId);

  if (session.pendingTurnTimer) {
    clearTimeout(session.pendingTurnTimer);
    session.pendingTurnTimer = undefined;
  }
}

function handleSpeechStopped(session: CallSession): void {
  if (!(session.configured && session.userSpeaking)) {
    return;
  }
  session.userSpeaking = false;
  logCallLifecycle(session.callId, "speech_detected", { phase: "stop" });
  if (!session.heardUser) {
    return;
  }
  if (session.pendingTurnTimer) {
    clearTimeout(session.pendingTurnTimer);
  }
  session.pendingTurnTimer = setTimeout(() => {
    requestTurnResponse(session);
    session.pendingTurnTimer = undefined;
  }, 150);
  logCallLifecycle(session.callId, "turn_timer_scheduled", { delayMs: 150 });
}

const realtimeEventHandlers: Record<string, RealtimeEventHandler> = {
  "response.created": (session, event) =>
    updateResponseLifecycle(session, event, "add"),
  "response.completed": (session, event) =>
    updateResponseLifecycle(session, event, "remove"),
  "response.done": (session, event) =>
    updateResponseLifecycle(session, event, "remove"),
  "response.output_text.delta": logResponseTextDelta,
  "response.output_audio.delta": logResponseAudioDelta,
  "session.updated": (session) => {
    session.configured = true;
  },
  "conversation.item.added": handleConversationItem,
  "conversation.item.done": handleConversationItem,
  "response.output_item.added": registerFunctionCall,
  "response.function_call_arguments.delta": collectToolArgs,
  "response.function_call_arguments.done": fulfillToolCall,
  "conversation.item.input_audio_transcription.completed": logInputTranscript,
  "input_audio_buffer.speech_started": (session) =>
    handleSpeechStarted(session),
  "input_audio_buffer.speech_stopped": (session) =>
    handleSpeechStopped(session),
  error: handleRealtimeError,
};

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "voice-agent-realtime",
    version: process.env.COMMIT_SHA ?? "local",
  })
);

app.get("/healthz", (c) => c.json({ ok: true }));

// Admin API endpoints for demo monitoring
app.get("/api/stats", (c) => {
  const stats = analytics.getSystemStats();
  return c.json(stats);
});

app.get("/api/calls", (c) => {
  const limit = Number(c.req.query("limit")) || 10;
  const calls = analytics.getRecentCalls(limit);
  return c.json({ calls, count: calls.length });
});

app.get("/api/calls/active", (c) => {
  const calls = analytics.getActiveCalls();
  return c.json({ calls, count: calls.length });
});

app.get("/api/calls/:callId", (c) => {
  const callId = c.req.param("callId");
  const metrics = analytics.getCallMetrics(callId);

  if (!metrics) {
    return c.json({ error: "Call not found" }, 404);
  }

  return c.json(metrics);
});

app.get("/api/calls/:callId/transcript", (c) => {
  const callId = c.req.param("callId");
  const transcript = analytics.getCallTranscript(callId);

  if (transcript.length === 0) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  return c.json({ callId, transcript, count: transcript.length });
});

// Real-time dashboard endpoint
app.get("/dashboard", (c) => {
  const stats = analytics.getSystemStats();
  const activeCalls = analytics.getActiveCalls();
  const recentCalls = analytics.getRecentCalls(5);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Assistant Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      padding: 2rem;
      min-height: 100vh;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 2rem;
      text-align: center;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .card {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 1rem;
      padding: 1.5rem;
      box-shadow: 0 8px 32px rgba(0,0,0,0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .card h2 {
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      opacity: 0.8;
      margin-bottom: 0.5rem;
    }
    .card .value {
      font-size: 2.5rem;
      font-weight: bold;
      margin-bottom: 0.5rem;
    }
    .card .label {
      font-size: 0.85rem;
      opacity: 0.7;
    }
    .section {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 1rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 8px 32px rgba(0,0,0,0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .section h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid rgba(255,255,255,0.2);
    }
    .call-item {
      background: rgba(255, 255, 255, 0.05);
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      border-left: 4px solid #4ade80;
    }
    .call-item.active { border-left-color: #22c55e; animation: pulse 2s infinite; }
    .call-item.completed { border-left-color: #3b82f6; }
    .call-item.failed { border-left-color: #ef4444; }
    .call-item.transferred { border-left-color: #f59e0b; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .call-meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
      font-size: 0.85rem;
      opacity: 0.8;
    }
    .badge {
      background: rgba(255, 255, 255, 0.2);
      padding: 0.25rem 0.75rem;
      border-radius: 1rem;
      font-size: 0.75rem;
    }
    .sentiment-positive { color: #4ade80; }
    .sentiment-negative { color: #f87171; }
    .sentiment-neutral { color: #fbbf24; }
    .refresh-btn {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(10px);
      border: none;
      color: white;
      padding: 1rem 2rem;
      border-radius: 2rem;
      cursor: pointer;
      font-size: 1rem;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      transition: all 0.3s ease;
    }
    .refresh-btn:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0,0,0,0.3);
    }
    .view-transcript-btn {
      background: rgba(255, 255, 255, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: white;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.85rem;
      margin-top: 0.5rem;
      transition: all 0.2s ease;
      display: inline-block;
    }
    .view-transcript-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      z-index: 1000;
      padding: 2rem;
      overflow-y: auto;
    }
    .modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-content {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(20px);
      border-radius: 1rem;
      padding: 2rem;
      max-width: 800px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid rgba(255, 255, 255, 0.2);
    }
    .close-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    .close-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }
    .transcript-entry {
      margin-bottom: 1rem;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 0.5rem;
      border-left: 3px solid #4ade80;
    }
    .transcript-entry.assistant {
      border-left-color: #3b82f6;
    }
    .transcript-speaker {
      font-weight: bold;
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      font-size: 0.85rem;
      opacity: 0.8;
    }
    .transcript-text {
      font-size: 1rem;
      line-height: 1.5;
    }
    .transcript-time {
      font-size: 0.75rem;
      opacity: 0.6;
      margin-top: 0.5rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎙️ Voice Assistant Dashboard</h1>

    <div class="grid">
      <div class="card">
        <h2>Active Calls</h2>
        <div class="value">${stats.activeCalls}</div>
        <div class="label">Currently in progress</div>
      </div>
      <div class="card">
        <h2>Total Calls</h2>
        <div class="value">${stats.totalCalls}</div>
        <div class="label">All time</div>
      </div>
      <div class="card">
        <h2>Completed</h2>
        <div class="value">${stats.completedCalls}</div>
        <div class="label">Successfully handled</div>
      </div>
      <div class="card">
        <h2>Tool Calls</h2>
        <div class="value">${stats.totalToolCalls}</div>
        <div class="label">Functions executed</div>
      </div>
      <div class="card">
        <h2>Avg Duration</h2>
        <div class="value">${Math.round(stats.averageCallDuration / 1000)}s</div>
        <div class="label">Per call</div>
      </div>
      <div class="card">
        <h2>Uptime</h2>
        <div class="value">${Math.floor(stats.uptime / (1000 * 60 * 60))}h</div>
        <div class="label">${Math.floor((stats.uptime % (1000 * 60 * 60)) / (1000 * 60))}m</div>
      </div>
    </div>

    ${
      activeCalls.length > 0
        ? `
    <div class="section">
      <h2>🔴 Active Calls (${activeCalls.length})</h2>
      ${activeCalls
        .map(
          (call) => `
        <div class="call-item active">
          <strong>Call ${call.callId.slice(0, 8)}</strong>
          <div class="call-meta">
            <span>⏱️ ${Math.floor((Date.now() - call.startTime) / 1000)}s</span>
            <span>🔧 ${call.toolCalls.length} tools</span>
            <span>💬 ${call.transcripts.length} messages</span>
            ${call.sentiment ? `<span class="sentiment-${call.sentiment}">😊 ${call.sentiment}</span>` : ""}
          </div>
        </div>
      `
        )
        .join("")}
    </div>
    `
        : ""
    }

    <div class="section">
      <h2>📊 Recent Calls</h2>
      ${
        recentCalls.length === 0
          ? "<p>No calls yet</p>"
          : recentCalls
              .map(
                (call) => `
        <div class="call-item ${call.status}">
          <strong>Call ${call.callId.slice(0, 8)}</strong>
          <span class="badge">${call.status}</span>
          <div class="call-meta">
            <span>⏱️ ${call.duration ? `${Math.floor(call.duration / 1000)}s` : "ongoing"}</span>
            <span>🔧 ${call.toolCalls.length} tools: ${call.toolCalls.map((t) => t.name).join(", ") || "none"}</span>
            <span>💬 ${call.transcripts.length} messages</span>
            ${call.sentiment ? `<span class="sentiment-${call.sentiment}">😊 ${call.sentiment}</span>` : ""}
          </div>
          ${
            call.transcripts.length > 0
              ? `
            <button class="view-transcript-btn" onclick="showTranscript('${call.callId}')">
              📝 View Transcript
            </button>
          `
              : ""
          }
        </div>
      `
              )
              .join("")
      }
    </div>

    <div class="section">
      <h2>🔧 Tool Usage</h2>
      ${
        Object.entries(stats.toolCallsByType).length === 0
          ? "<p>No tools used yet</p>"
          : Object.entries(stats.toolCallsByType)
              .map(
                ([tool, count]) => `
        <div style="margin-bottom: 0.75rem;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
            <span>${tool}</span>
            <strong>${count}</strong>
          </div>
          <div style="background: rgba(255,255,255,0.1); height: 8px; border-radius: 4px; overflow: hidden;">
            <div style="background: #4ade80; height: 100%; width: ${(count / stats.totalToolCalls) * 100}%; transition: width 0.3s;"></div>
          </div>
        </div>
      `
              )
              .join("")
      }
    </div>
  </div>

  <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>

  <div id="transcriptModal" class="modal" onclick="closeModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2 id="modalTitle">Transcript</h2>
        <button class="close-btn" onclick="closeModal()">✕ Close</button>
      </div>
      <div id="transcriptContent">
        Loading...
      </div>
    </div>
  </div>

  <script>
    async function showTranscript(callId) {
      const modal = document.getElementById('transcriptModal');
      const content = document.getElementById('transcriptContent');
      const title = document.getElementById('modalTitle');

      modal.classList.add('active');
      content.innerHTML = '<p style="text-align: center; padding: 2rem;">Loading transcript...</p>';
      title.textContent = 'Transcript - Call ' + callId.slice(0, 8);

      try {
        const response = await fetch('/api/calls/' + callId + '/transcript');
        const data = await response.json();

        if (data.error) {
          content.innerHTML = '<p style="color: #f87171;">No transcript available</p>';
          return;
        }

        if (data.transcript.length === 0) {
          content.innerHTML = '<p style="opacity: 0.7;">No messages yet</p>';
          return;
        }

        content.innerHTML = data.transcript.map(entry => {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const speakerClass = entry.speaker === 'assistant' ? 'assistant' : 'user';
          const speakerLabel = entry.speaker === 'user' ? '👤 User' : '🤖 Assistant';

          return \`
            <div class="transcript-entry \${speakerClass}">
              <div class="transcript-speaker">\${speakerLabel}</div>
              <div class="transcript-text">\${entry.text}</div>
              <div class="transcript-time">\${time}\${entry.sentiment ? ' • ' + entry.sentiment : ''}</div>
            </div>
          \`;
        }).join('');
      } catch (error) {
        content.innerHTML = '<p style="color: #f87171;">Error loading transcript</p>';
      }
    }

    function closeModal(event) {
      if (!event || event.target.id === 'transcriptModal') {
        document.getElementById('transcriptModal').classList.remove('active');
      }
    }

    // Auto-refresh every 5 seconds
    setTimeout(() => location.reload(), 5000);
  </script>
</body>
</html>`;

  return c.html(html);
});

app.post("/openai/webhook", async (c) => {
  const rawBody = await c.req.text();
  let payload: unknown;

  try {
    if (config.testMode) {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } else {
      payload = await openai.webhooks.unwrap(rawBody, c.req.raw.headers);
    }
  } catch (error) {
    console.error("Webhook verification failed", error);
    return c.json({ error: "signature_invalid" }, 400);
  }

  const event: Record<string, unknown> = isRecord(payload) ? payload : {};
  const eventType = getString(event.type) ?? "unknown";
  const data = isRecord(event.data) ? event.data : undefined;
  const callId = data ? getString(data.call_id) : undefined;
  logWebhook(eventType, { call_id: callId });

  if (eventType === "realtime.call.incoming") {
    if (!callId) {
      return c.json({ error: "missing_call_id" }, 400);
    }

    setTimeout(() => {
      handleIncomingCall(callId).catch((error) => {
        console.error("Failed to handle incoming call", error);
      });
    }, 0);

    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

async function handleIncomingCall(callId: string): Promise<void> {
  // Start analytics tracking
  analytics.startCall(callId);
  logger.call(callId, "Incoming call received");

  const sessionConfig: RealtimeSessionConfig = {
    type: "realtime",
    model: config.model,
    tools: realtimeToolSchemas,
    tool_choice: "none",
    instructions: systemPrompt, // keep: proven to work E2E
  };

  try {
    await acceptCall(callId, sessionConfig);
    logCallLifecycle(callId, "accepted");
    logger.call(callId, "Call accepted successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("call_id_not_found")) {
      logCallLifecycle(callId, "accept_skipped", {
        reason: "call_id_not_found",
      });
      analytics.endCall(callId, "failed");
      return;
    }
    analytics.endCall(callId, "failed");
    throw error;
  }

  attachSidebandWebSocket(callId);
}

function buildRealtimeWsUrl(callId: string): string {
  const base = config.realtimeWsUrl.replace(TRAILING_SLASH_REGEX, "");
  const url = new URL(base);
  if (!V1_REALTIME_REGEX.test(url.pathname)) {
    url.pathname = url.pathname.replace(REALTIME_SUFFIX_REGEX, "/v1/realtime");
  }
  url.searchParams.set("call_id", callId);
  if (config.isAzure && config.apiVersion) {
    url.searchParams.set("api-version", config.apiVersion);
  }
  return url.toString();
}

function attachSidebandWebSocket(callId: string): void {
  const wsUrl = buildRealtimeWsUrl(callId);
  const ws = new WebSocket(wsUrl, {
    headers: config.isAzure
      ? { "api-key": config.apiKey }
      : { Authorization: `Bearer ${config.apiKey}` },
  });

  const session: CallSession = {
    callId,
    ws,
    pendingTools: new Map(),
    activeResponses: new Set(),
    configured: false,
    greeted: false,
    toolsUnlocked: false,
    responseGateUntil: 0,
    minGapMs: 500,
    userSpeaking: false,
    heardUser: false,
    bargeGuardUntil: 0,
    pendingFollowUps: [],
  };

  sessions.set(callId, session);

  ws.on("open", () => {
    logCallLifecycle(callId, "ws_opened");

    // Configure session + voice (modern field). If Azure complains, we fallback in handleRealtimeError.
    sendSessionUpdate(session, {
      type: "realtime",
      audio: { output: { voice: config.voice } },
    });

    if (!session.greeted) {
      maybeRespond(session, {
        instructions: `Speak the following greeting verbatim with no additions: ${greetingPrompt}`,
        source: "greeting",
      });
      session.greeted = true;
      session.bargeGuardUntil = Date.now() + 2000;
    }
  });

  ws.on("message", async (buffer: Buffer) => {
    const text = buffer.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    await routeRealtimeEvent(session, parsed);
  });

  ws.on("close", () => {
    logCallLifecycle(callId, "ws_closed");
    analytics.endCall(callId, "completed");
    logger.call(callId, "Call ended");

    // Log call summary
    const metrics = analytics.getCallMetrics(callId);
    if (metrics) {
      logger.callSummary(callId, {
        duration: metrics.duration,
        toolCalls: metrics.toolCalls.length,
        transcripts: metrics.transcripts.length,
        sentiment: metrics.sentiment,
        status: metrics.status,
      });
    }

    sessions.delete(callId);
  });

  ws.on("error", (error: Error) => {
    logCallLifecycle(callId, "ws_error", { message: error.message });
  });
}

async function routeRealtimeEvent(
  session: CallSession,
  event: Record<string, unknown>
): Promise<void> {
  const type = getString(event.type);
  logCallLifecycle(session.callId, "rt_event", describeRealtimeEvent(event));

  if (!type) {
    return;
  }

  const handler = realtimeEventHandlers[type];
  if (!handler) {
    return;
  }

  await handler(session, event);
}

function sendSessionUpdate(
  session: CallSession,
  patch: Record<string, unknown>
): void {
  if (Object.keys(patch).length === 0) {
    return;
  }

  const update = Object.hasOwn(patch, "type")
    ? patch
    : { type: "realtime", ...patch };

  session.ws.send(JSON.stringify({ type: "session.update", session: update }));
}

function handleRealtimeError(
  session: CallSession,
  event: Record<string, unknown>
): void {
  logCallLifecycle(session.callId, "realtime_error", { detail: event });

  const error = isRecord(event.error) ? event.error : undefined;
  const code = error ? getString(error.code) : undefined;
  const param = error ? getString(error.param) : undefined;

  // Azure may reject "audio.output.voice" in some combos; retry with "voice"
  if (
    (code === "unknown_parameter" || code === "invalid_request_error") &&
    param &&
    param.includes("voice")
  ) {
    sendSessionUpdate(session, { voice: config.voice });
    logCallLifecycle(session.callId, "voice_fallback_applied", {
      via: "session.voice",
    });
  }
}

function updateResponseLifecycle(
  session: CallSession,
  event: Record<string, unknown>,
  action: "add" | "remove"
): void {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = response ? getString(response.id) : undefined;
  if (!responseId) {
    return;
  }

  if (action === "add") {
    session.activeResponses.add(responseId);
  } else {
    session.activeResponses.delete(responseId);
    if (session.activeResponses.size === 0) {
      flushPendingFollowUps(session);
    }
  }
}

function registerFunctionCall(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const item = isRecord(event.item) ? event.item : undefined;
  const itemType = item ? getString(item.type) : undefined;
  const itemId = item ? getString(item.id) : undefined;
  const name = item ? getString(item.name) : undefined;
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = response ? getString(response.id) : undefined;

  if (itemType === "function_call" && itemId && name) {
    if (!session.heardUser) {
      logCallLifecycle(session.callId, "tool_call_blocked_pre_speech", {
        itemId,
        name,
      });
      if (responseId) {
        session.ws.send(
          JSON.stringify({ type: "response.cancel", response_id: responseId })
        );
        session.activeResponses.delete(responseId);
      }
      return;
    }
    session.pendingTools.set(itemId, { name, argsBuffer: "" });
    logCallLifecycle(session.callId, "tool_call_registered", { itemId, name });
  }
}

function logInputTranscript(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const transcript = getString(event.transcript);
  if (transcript) {
    logTranscript(session.callId, transcript);
    logCallLifecycle(session.callId, "transcript_completed", {
      text: truncate(transcript, 160),
    });

    // Track transcript in analytics
    analytics.recordTranscript(session.callId, {
      timestamp: Date.now(),
      speaker: "user",
      text: transcript,
    });

    // Enhanced logging
    logger.transcript(session.callId, "user", transcript);

    if (!session.heardUser) {
      session.heardUser = true;
      session.bargeGuardUntil = 0;
      unlockTools(session, "transcript");
    }
  }
}

function handleConversationItem(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const item = isRecord(event.item) ? event.item : undefined;
  if (!item) {
    return;
  }
  const role = getString(item.role);
  if (role === "user" && !session.heardUser) {
    session.heardUser = true;
    session.bargeGuardUntil = 0;
    unlockTools(session, "conversation_item");
  }
}

function unlockTools(session: CallSession, reason: string): void {
  if (session.toolsUnlocked) {
    return;
  }
  sendSessionUpdate(session, { tool_choice: "auto" });
  session.toolsUnlocked = true;
  logCallLifecycle(session.callId, "tools_unlocked", { reason });
}

type ResponseRequest = {
  instructions: string;
  source: string;
  outOfBand?: boolean;
  queueIfBlocked?: boolean;
};

function maybeRespond(session: CallSession, request: ResponseRequest): void {
  const now = Date.now();
  const snippet = truncate(request.instructions, 180);

  if (session.activeResponses.size > 0) {
    logCallLifecycle(session.callId, "response_skipped_active", {
      source: request.source,
      activeResponses: session.activeResponses.size,
      snippet,
    });
    if (request.queueIfBlocked) {
      enqueueFollowUp(session, request);
    }
    return;
  }
  if (now < session.responseGateUntil) {
    logCallLifecycle(session.callId, "response_skipped_gate", {
      source: request.source,
      waitMs: session.responseGateUntil - now,
      snippet,
    });
    if (request.queueIfBlocked) {
      enqueueFollowUp(session, request);
    }
    return;
  }

  const response: Record<string, unknown> = {
    instructions: request.instructions,
  };
  session.ws.send(JSON.stringify({ type: "response.create", response }));
  logCallLifecycle(session.callId, "response_enqueued", {
    source: request.source,
    snippet,
  });
  analytics.recordResponse(session.callId);
  session.responseGateUntil = now + session.minGapMs;
}

function enqueueFollowUp(session: CallSession, request: ResponseRequest): void {
  session.pendingFollowUps.push({ ...request, queueIfBlocked: true });
  logCallLifecycle(session.callId, "follow_up_queued", {
    source: request.source,
    queueLength: session.pendingFollowUps.length,
  });
}

function flushPendingFollowUps(session: CallSession): void {
  if (session.pendingFollowUps.length === 0) {
    return;
  }
  const next = session.pendingFollowUps.shift();
  if (next) {
    maybeRespond(session, next);
  }
}

function requestTurnResponse(session: CallSession): void {
  maybeRespond(session, {
    instructions:
      "Please respond briefly and helpfully to the caller’s last statement.",
    source: "turn_response",
  });
}

function collectToolArgs(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const itemId = getString(event.item_id);
  if (!itemId) {
    return;
  }

  const pending = session.pendingTools.get(itemId);
  if (!pending) {
    return;
  }

  const delta = getString(event.delta);
  if (delta) {
    pending.argsBuffer += delta;
    logCallLifecycle(session.callId, "tool_args_delta", {
      itemId,
      deltaLength: delta.length,
      totalLength: pending.argsBuffer.length,
    });
  }
}

async function fulfillToolCall(
  session: CallSession,
  event: Record<string, unknown>
): Promise<void> {
  const itemId = getString(event.item_id);
  if (!itemId) {
    return;
  }

  const pending = session.pendingTools.get(itemId);
  if (!pending) {
    return;
  }

  session.pendingTools.delete(itemId);

  const argsPayload = getString(event.arguments) ?? pending.argsBuffer;
  let parsedArgs: unknown = {};

  if (typeof argsPayload === "string" && argsPayload.trim().length > 0) {
    try {
      parsedArgs = JSON.parse(argsPayload);
    } catch {
      parsedArgs = {};
    }
  }

  const toolStartTime = Date.now();
  try {
    logCallLifecycle(session.callId, "tool_dispatch", {
      name: pending.name,
      itemId,
      args: truncate(
        typeof argsPayload === "string"
          ? argsPayload
          : JSON.stringify(parsedArgs),
        200
      ),
    });
    logger.tool(session.callId, pending.name, "start", parsedArgs);

    const result = await runTool(pending.name, parsedArgs, {
      callId: session.callId,
    });

    const toolDuration = Date.now() - toolStartTime;

    // Track tool call in analytics
    analytics.recordToolCall(session.callId, {
      name: pending.name,
      timestamp: toolStartTime,
      duration: toolDuration,
      success: true,
      args: parsedArgs,
    });

    logger.tool(session.callId, pending.name, "success", {
      duration: toolDuration,
      output: result.output,
    });

    const functionCallId = getString(event.call_id);
    if (functionCallId) {
      sendFunctionResult(session, functionCallId, result.output);
    }

    // Track transfer if handoff_human was called
    if (pending.name === "handoff_human") {
      analytics.setTransferReason(
        session.callId,
        (parsedArgs as { reason?: string })?.reason ?? "unknown"
      );
    }

    const followUp =
      result.followUpInstructions ??
      "Summarize the result briefly and confirm the next steps in clear, concise English.";
    maybeRespond(session, {
      instructions: followUp,
      source: "tool_follow_up_success",
      queueIfBlocked: true,
    });
  } catch (error) {
    const toolDuration = Date.now() - toolStartTime;
    const errorMessage = error instanceof Error ? error.message : "unknown";

    // Track failed tool call
    analytics.recordToolCall(session.callId, {
      name: pending.name,
      timestamp: toolStartTime,
      duration: toolDuration,
      success: false,
      error: errorMessage,
    });

    logger.tool(session.callId, pending.name, "error", {
      duration: toolDuration,
      error: errorMessage,
    });

    console.error("Tool execution failed", error);
    maybeRespond(session, {
      instructions:
        "Apologize briefly, explain that the check failed, and offer to transfer to a human right away.",
      source: "tool_follow_up_error",
      queueIfBlocked: true,
    });
  }
}

function sendFunctionResult(
  session: CallSession,
  callId: string,
  output: Record<string, unknown>
): void {
  session.ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
  );
}

function cancelActiveResponses(session: CallSession): void {
  if (session.activeResponses.size === 0) {
    return;
  }

  for (const responseId of session.activeResponses) {
    session.ws.send(
      JSON.stringify({ type: "response.cancel", response_id: responseId })
    );
    logCallLifecycle(session.callId, "response_cancel", { responseId });
  }
  session.activeResponses.clear();
}

if (import.meta.main) {
  const server = serve({ fetch: app.fetch, port: config.port });

  // Display impressive startup banner
  logger.banner("Azure OpenAI Realtime Voice Assistant");
  logger.success("Server started successfully", {
    url: server.url.toString(),
    port: config.port,
    model: config.model,
    voice: config.voice,
  });
  logger.info("Dashboard available at: /dashboard");
  logger.info("API endpoints:", {
    stats: "/api/stats",
    calls: "/api/calls",
    activeCalls: "/api/calls/active",
  });
  logger.separator();
  logger.info("Waiting for incoming calls...");

  // Log stats every 5 minutes
  setInterval(
    () => {
      const stats = analytics.getSystemStats();
      if (stats.totalCalls > 0) {
        logger.stats(stats);
      }
    },
    5 * 60 * 1000
  );
}
