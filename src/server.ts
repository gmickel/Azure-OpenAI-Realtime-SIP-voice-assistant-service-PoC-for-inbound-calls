import { serve } from 'bun';
import { Hono } from 'hono';
import OpenAI from 'openai';
import WebSocket from 'ws';
import { analytics } from './analytics';
import { acceptCall, type RealtimeSessionConfig } from './callflow';
import { config } from './config';
import { logger } from './logger';
import { logCallLifecycle, logTranscript, logWebhook } from './observe';
import { greetingPrompt, systemPrompt } from './prompts';
import { realtimeToolSchemas, runTool } from './tools';

const SIP_PHONE_REGEX = /sip:(\+?\d+)@/;

function extractCallerPhone(sipHeaders: unknown[]): string | undefined {
  const fromHeader = sipHeaders.find((h: unknown) => {
    if (!isRecord(h)) {
      return false;
    }
    return getString(h.name)?.toLowerCase() === 'from';
  });

  if (fromHeader && isRecord(fromHeader)) {
    const fromValue = getString(fromHeader.value);
    const phoneMatch = fromValue?.match(SIP_PHONE_REGEX);
    return phoneMatch?.[1];
  }

  return;
}

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
  responseTextBuffers: Map<string, string>;
  assistantTranscriptBuffers: Map<string, string>;
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
  typeof value === 'object' && value !== null;

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const truncate = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const describeRealtimeEvent = (
  event: Record<string, unknown>
): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    type: getString(event.type) ?? 'unknown',
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
      message: truncate(errorMessage ?? '', 120),
    };
  }

  return summary;
};

function logResponseTextDelta(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const delta = getString(event.delta);
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = response ? getString(response.id) : undefined;

  if (delta && responseId) {
    // Accumulate response text for transcript
    const current = session.responseTextBuffers.get(responseId) || '';
    session.responseTextBuffers.set(responseId, current + delta);

    logCallLifecycle(session.callId, 'response_text_delta', {
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
    logCallLifecycle(session.callId, 'response_audio_chunk', {
      bytes: chunk.length,
    });
  }
}

function handleSpeechStarted(session: CallSession): void {
  session.userSpeaking = true;
  logCallLifecycle(session.callId, 'speech_detected', { phase: 'start' });
  analytics.recordSpeechEvent(session.callId);

  if (!session.toolsUnlocked && Date.now() < session.bargeGuardUntil) {
    logCallLifecycle(session.callId, 'barge_guard_active', {
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
  logCallLifecycle(session.callId, 'speech_detected', { phase: 'stop' });
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
  logCallLifecycle(session.callId, 'turn_timer_scheduled', { delayMs: 150 });
}

const realtimeEventHandlers: Record<string, RealtimeEventHandler> = {
  'response.created': (session, event) =>
    updateResponseLifecycle(session, event, 'add'),
  'response.completed': (session, event) =>
    updateResponseLifecycle(session, event, 'remove'),
  'response.done': (session, event) =>
    updateResponseLifecycle(session, event, 'remove'),
  'response.output_text.delta': logResponseTextDelta,
  'response.output_audio.delta': logResponseAudioDelta,
  // Azure-specific assistant transcript events
  'response.output_audio_transcript.delta': handleAssistantTranscriptDelta,
  'response.output_audio_transcript.done': handleAssistantTranscriptDone,
  // Standard OpenAI assistant transcript events (fallback)
  'response.audio_transcript.delta': handleAssistantTranscriptDelta,
  'response.audio_transcript.done': handleAssistantTranscriptDone,
  'session.updated': (session, event) => {
    session.configured = true;
    // Verify transcription was applied (should be set from /accept payload)
    const sessionData = isRecord(event.session) ? event.session : undefined;
    const transcription = sessionData
      ? (sessionData.input_audio_transcription ?? null)
      : null;
    if (transcription) {
      logger.info('User transcription armed', {
        callId: session.callId,
        model: isRecord(transcription)
          ? getString(transcription.model)
          : 'unknown',
      });
    } else {
      logger.warning('User transcription NOT configured in session', {
        callId: session.callId,
      });
    }
  },
  'conversation.item.added': handleConversationItem,
  'conversation.item.done': handleConversationItem,
  'conversation.item.created': handleConversationItem, // broader compatibility
  'conversation.item.retrieved': handleConversationItem, // broader compatibility
  'response.output_item.added': registerFunctionCall,
  'response.function_call_arguments.delta': collectToolArgs,
  'response.function_call_arguments.done': fulfillToolCall,
  // Standard Azure user transcription events
  'conversation.item.input_audio_transcription.completed': logInputTranscript,
  'conversation.item.input_audio_transcription.failed': (session, event) => {
    const error = isRecord(event.error) ? event.error : {};
    logger.warning('User input transcription failed', {
      callId: session.callId,
      itemId: getString(event.item_id),
      error: {
        code: getString(error.code),
        message: getString(error.message),
      },
    });
  },
  // Alternate spellings (seen in some Azure docs/samples)
  'conversation.item.audio_transcription.completed': logInputTranscript,
  'conversation.item.audio_transcription.failed': (session, event) => {
    const error = isRecord(event.error) ? event.error : {};
    logger.warning('User input transcription failed', {
      callId: session.callId,
      itemId: getString(event.item_id),
      error: {
        code: getString(error.code),
        message: getString(error.message),
      },
    });
  },
  'input_audio_buffer.speech_started': (session) =>
    handleSpeechStarted(session),
  'input_audio_buffer.speech_stopped': (session) =>
    handleSpeechStopped(session),
  error: handleRealtimeError,
};

app.get('/', (c) =>
  c.json({
    ok: true,
    service: 'voice-agent-realtime',
    version: process.env.COMMIT_SHA ?? 'local',
  })
);

app.get('/healthz', (c) => c.json({ ok: true }));

// Admin API endpoints for demo monitoring
app.get('/api/stats', (c) => {
  const stats = analytics.getSystemStats();
  return c.json(stats);
});

app.get('/api/calls', (c) => {
  const limit = Number(c.req.query('limit')) || 10;
  const calls = analytics.getRecentCalls(limit);
  return c.json({ calls, count: calls.length });
});

app.get('/api/calls/active', (c) => {
  const calls = analytics.getActiveCalls();
  return c.json({ calls, count: calls.length });
});

app.get('/api/calls/:callId', (c) => {
  const callId = c.req.param('callId');
  const metrics = analytics.getCallMetrics(callId);

  if (!metrics) {
    return c.json({ error: 'Call not found' }, 404);
  }

  return c.json(metrics);
});

app.get('/api/calls/:callId/transcript', (c) => {
  const callId = c.req.param('callId');
  const transcript = analytics.getCallTranscript(callId);

  if (transcript.length === 0) {
    return c.json({ error: 'Transcript not found' }, 404);
  }

  return c.json({ callId, transcript, count: transcript.length });
});

// Demo data generation for testing dashboard
app.post('/api/demo/generate', (c) => {
  const demoCallId = `demo-${Date.now()}`;
  analytics.startCall(demoCallId);

  // Add demo transcripts
  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 30_000,
    speaker: 'user',
    text: 'Hello, I need to check my order status.',
  });

  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 28_000,
    speaker: 'assistant',
    text: "Hi! I'd be happy to help you check your order status. Could you please provide your order number?",
  });

  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 25_000,
    speaker: 'user',
    text: "Sure, it's ACME-12345.",
  });

  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 23_000,
    speaker: 'assistant',
    text: 'Let me check that for you right away.',
  });

  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 20_000,
    speaker: 'assistant',
    text: 'Your order ACME-12345 is currently processing and should ship within about 2 days. Is there anything else I can help you with?',
  });

  analytics.recordTranscript(demoCallId, {
    timestamp: Date.now() - 18_000,
    speaker: 'user',
    text: "No, that's perfect. Thank you!",
  });

  // Add demo tool calls
  analytics.recordToolCall(demoCallId, {
    name: 'lookup_order',
    timestamp: Date.now() - 22_000,
    duration: 120,
    success: true,
    args: { orderNumber: 'ACME-12345' },
  });

  analytics.recordResponse(demoCallId);
  analytics.recordSpeechEvent(demoCallId);

  analytics.endCall(demoCallId, 'completed');

  return c.json({
    success: true,
    callId: demoCallId,
    message: 'Demo call data generated successfully',
  });
});

// SSE endpoint for live dashboard updates
app.get('/api/events', (c) => {
  return c.newResponse(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const sendUpdate = () => {
          const stats = analytics.getSystemStats();
          const activeCalls = analytics.getActiveCalls();
          const recentCalls = analytics.getRecentCalls(5);

          const data = JSON.stringify({ stats, activeCalls, recentCalls });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        // Send initial data
        sendUpdate();

        // Send updates every 2 seconds
        const interval = setInterval(sendUpdate, 2000);

        // Cleanup on close
        c.req.raw.signal?.addEventListener('abort', () => {
          clearInterval(interval);
          controller.close();
        });
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});

// Real-time dashboard endpoint
app.get('/dashboard', (c) => {
  const stats = analytics.getSystemStats();
  const activeCalls = analytics.getActiveCalls();
  const recentCalls = analytics.getRecentCalls(5);

  const html = `
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
        <div class="stat-value">${stats.activeCalls}</div>
        <div class="stat-sublabel">In Progress</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Sessions</div>
        <div class="stat-value">${stats.totalCalls}</div>
        <div class="stat-sublabel">All Time</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value">${stats.completedCalls}</div>
        <div class="stat-sublabel">Successful</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Tool Calls</div>
        <div class="stat-value">${stats.totalToolCalls}</div>
        <div class="stat-sublabel">Executed</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Duration</div>
        <div class="stat-value">${Math.round(stats.averageCallDuration / 1000)}s</div>
        <div class="stat-sublabel">Per Call</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">System Uptime</div>
        <div class="stat-value">${Math.floor(stats.uptime / (1000 * 60 * 60))}h</div>
        <div class="stat-sublabel">${Math.floor((stats.uptime % (1000 * 60 * 60)) / (1000 * 60))}m</div>
      </div>
    </div>

    ${
      activeCalls.length > 0
        ? `
    <div class="section">
      <div class="section-header">
        <span>Active Calls</span>
        <div class="live-indicator">LIVE</div>
      </div>
      ${activeCalls
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
        .join('')}
    </div>
    `
        : ''
    }

    <div class="section">
      <div class="section-header">Recent Activity</div>
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

    <div class="section">
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

        // Update stat values only (non-intrusive)
        const statValues = document.querySelectorAll('.stat-value');
        if (statValues[0]) statValues[0].textContent = stats.activeCalls;
        if (statValues[1]) statValues[1].textContent = stats.totalCalls;
        if (statValues[2]) statValues[2].textContent = stats.completedCalls;
        if (statValues[3]) statValues[3].textContent = stats.totalToolCalls;
        if (statValues[4]) statValues[4].textContent = Math.round(stats.averageCallDuration / 1000) + 's';
        if (statValues[5]) statValues[5].textContent = Math.floor(stats.uptime / (1000 * 60 * 60)) + 'h';

        // Update uptime sublabel
        const uptimeSublabel = document.querySelector('.stat-card:last-child .stat-sublabel');
        if (uptimeSublabel) {
          uptimeSublabel.textContent = Math.floor((stats.uptime % (1000 * 60 * 60)) / (1000 * 60)) + 'm';
        }

        // Update active calls section
        const activeCallsSection = document.querySelector('.section:nth-child(2) .call-grid');
        if (activeCallsSection) {
          if (activeCalls.length === 0) {
            activeCallsSection.innerHTML = '<div class="empty-state">No active calls</div>';
          } else {
            activeCallsSection.innerHTML = activeCalls.map(call => \`
              <div class="call-card active">
                <div class="call-header">
                  <span class="call-id">\${call.callId.slice(0, 8).toUpperCase()}</span>
                  <span class="badge \${call.status}">\${call.status.toUpperCase()}</span>
                </div>
                <div class="call-meta">
                  \${call.metadata.callerPhone ? \`<div class="meta-item">
                    <span class="meta-label">📞 Caller:</span>
                    <span class="meta-value">\${call.metadata.callerPhone}</span>
                  </div>\` : ''}
                  <div class="meta-item">
                    <span class="meta-label">Duration:</span>
                    <span class="meta-value">\${call.duration ? Math.floor((Date.now() - call.startTime) / 1000) + 's' : 'N/A'}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Tools:</span>
                    <span class="meta-value">\${call.toolCalls.length}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Messages:</span>
                    <span class="meta-value">\${call.transcripts.length}</span>
                  </div>
                </div>
              </div>
            \`).join('');
          }
        }

        // Update recent activity section
        const recentActivitySection = document.querySelector('.section:nth-child(3) .call-grid');
        if (recentActivitySection) {
          if (recentCalls.length === 0) {
            recentActivitySection.innerHTML = '<div class="empty-state">No recent calls</div>';
          } else {
            recentActivitySection.innerHTML = recentCalls.map(call => \`
              <div class="call-card">
                <div class="call-header">
                  <span class="call-id">\${call.callId.slice(0, 8).toUpperCase()}</span>
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
        }

        // Update tool usage stats section
        const toolStatsSection = document.querySelector('.section:nth-child(4)');
        if (toolStatsSection) {
          const toolContent = Object.entries(stats.toolCallsByType || {}).length === 0
            ? '<div class="empty-state">No tools used yet</div>'
            : \`<div class="tool-bar">\${Object.entries(stats.toolCallsByType).map(([tool, count]) => \`
                <div class="tool-item">
                  <span class="tool-name">\${tool}</span>
                  <div class="tool-bar-bg">
                    <div class="tool-bar-fill" style="width: \${(count / stats.totalToolCalls) * 100}%"></div>
                  </div>
                  <span class="tool-count">\${count}</span>
                </div>
              \`).join('')}</div>\`;

          toolStatsSection.innerHTML = \`<div class="section-header">Tool Usage Stats</div>\${toolContent}\`;
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

  return c.html(html);
});

app.post('/openai/webhook', async (c) => {
  const rawBody = await c.req.text();
  let payload: unknown;

  try {
    if (config.testMode) {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } else {
      payload = await openai.webhooks.unwrap(rawBody, c.req.raw.headers);
    }
  } catch (error) {
    console.error('Webhook verification failed', error);
    return c.json({ error: 'signature_invalid' }, 400);
  }

  const event: Record<string, unknown> = isRecord(payload) ? payload : {};
  const eventType = getString(event.type) ?? 'unknown';
  const data = isRecord(event.data) ? event.data : undefined;
  const callId = data ? getString(data.call_id) : undefined;

  if (eventType === 'realtime.call.incoming') {
    if (!callId) {
      return c.json({ error: 'missing_call_id' }, 400);
    }

    // Extract caller phone number from SIP headers
    const sipHeaders = Array.isArray(data.sip_headers) ? data.sip_headers : [];
    const callerPhone = extractCallerPhone(sipHeaders);

    logWebhook(eventType, { call_id: callId, caller: callerPhone });

    setTimeout(() => {
      handleIncomingCall(callId, callerPhone).catch((error) => {
        console.error('Failed to handle incoming call', error);
      });
    }, 0);

    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

async function handleIncomingCall(
  callId: string,
  callerPhone?: string
): Promise<void> {
  // Start analytics tracking
  analytics.startCall(callId);

  // Store caller phone number
  if (callerPhone) {
    analytics.setCallMetadata(callId, 'callerPhone', callerPhone);
  }

  logger.call(callId, 'Incoming call received', { caller: callerPhone });

  const sessionConfig: RealtimeSessionConfig = {
    type: 'realtime',
    model: config.model,
    tools: realtimeToolSchemas,
    tool_choice: 'none',
    instructions: systemPrompt,
  };

  try {
    await acceptCall(callId, sessionConfig);
    logCallLifecycle(callId, 'accepted');
    logger.call(callId, 'Call accepted successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('call_id_not_found')) {
      logCallLifecycle(callId, 'accept_skipped', {
        reason: 'call_id_not_found',
      });
      analytics.endCall(callId, 'failed');
      return;
    }
    analytics.endCall(callId, 'failed');
    throw error;
  }

  attachSidebandWebSocket(callId);
}

function buildRealtimeWsUrl(callId: string): string {
  const base = config.realtimeWsUrl.replace(TRAILING_SLASH_REGEX, '');
  const url = new URL(base);
  if (!V1_REALTIME_REGEX.test(url.pathname)) {
    url.pathname = url.pathname.replace(REALTIME_SUFFIX_REGEX, '/v1/realtime');
  }
  url.searchParams.set('call_id', callId);
  if (config.isAzure && config.apiVersion) {
    url.searchParams.set('api-version', config.apiVersion);
  }
  return url.toString();
}

function attachSidebandWebSocket(callId: string): void {
  const wsUrl = buildRealtimeWsUrl(callId);
  const ws = new WebSocket(wsUrl, {
    headers: config.isAzure
      ? { 'api-key': config.apiKey }
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
    responseTextBuffers: new Map(),
    assistantTranscriptBuffers: new Map(),
  };

  sessions.set(callId, session);

  ws.on('open', () => {
    logCallLifecycle(callId, 'ws_opened');

    // CRITICAL: Enable transcription+VAD IMMEDIATELY on WS open (before audio flows)
    // Azure SIP requires session.update (not /accept body) for transcription config
    sendSessionUpdate(session, {
      type: 'realtime',
      audio: { output: { voice: config.voice } },
      input_audio_transcription: { model: 'gpt-4o-transcribe' },
      turn_detection: { type: 'server_vad', interrupt_response: true },
    });

    logger.info('Transcription config sent immediately on WS open', { callId });

    if (!session.greeted) {
      maybeRespond(session, {
        instructions: `Speak the following greeting verbatim with no additions: ${greetingPrompt}`,
        source: 'greeting',
      });
      session.greeted = true;
      session.bargeGuardUntil = Date.now() + 2000;
    }
  });

  ws.on('message', async (buffer: Buffer) => {
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

  ws.on('close', () => {
    logCallLifecycle(callId, 'ws_closed');
    analytics.endCall(callId, 'completed');
    logger.call(callId, 'Call ended');

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

  ws.on('error', (error: Error) => {
    logCallLifecycle(callId, 'ws_error', { message: error.message });
  });
}

async function routeRealtimeEvent(
  session: CallSession,
  event: Record<string, unknown>
): Promise<void> {
  const type = getString(event.type);
  logCallLifecycle(session.callId, 'rt_event', describeRealtimeEvent(event));

  if (!type) {
    return;
  }

  // Log ALL event types for debugging transcription (when DEBUG_LOGGING=1)
  if (
    config.debugLogging &&
    (type.includes('audio') || type.includes('speech') || type.includes('item'))
  ) {
    logger.debug(`Event: ${type}`, {
      callId: session.callId,
      keys: Object.keys(event).join(','),
    });
  }

  const handler = realtimeEventHandlers[type];
  if (!handler) {
    if (type.includes('transcription') || type.includes('transcript')) {
      logger.warning(`Unhandled transcription event: ${type}`, {
        callId: session.callId,
        eventSample: JSON.stringify(event).slice(0, 200),
      });
    }
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

  const update = Object.hasOwn(patch, 'type')
    ? patch
    : { type: 'realtime', ...patch };

  session.ws.send(JSON.stringify({ type: 'session.update', session: update }));
}

function handleRealtimeError(
  session: CallSession,
  event: Record<string, unknown>
): void {
  logCallLifecycle(session.callId, 'realtime_error', { detail: event });

  const error = isRecord(event.error) ? event.error : undefined;
  const code = error ? getString(error.code) : undefined;
  const param = error ? getString(error.param) : undefined;

  // Azure may reject "audio.output.voice" in some combos; retry with "voice"
  if (
    (code === 'unknown_parameter' || code === 'invalid_request_error') &&
    param &&
    param.includes('voice')
  ) {
    sendSessionUpdate(session, { voice: config.voice });
    logCallLifecycle(session.callId, 'voice_fallback_applied', {
      via: 'session.voice',
    });
  }
}

function updateResponseLifecycle(
  session: CallSession,
  event: Record<string, unknown>,
  action: 'add' | 'remove'
): void {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = response ? getString(response.id) : undefined;
  if (!responseId) {
    return;
  }

  if (action === 'add') {
    session.activeResponses.add(responseId);
  } else {
    // Record assistant transcript when response completes
    const responseText = session.responseTextBuffers.get(responseId);
    if (responseText && responseText.trim().length > 0) {
      analytics.recordTranscript(session.callId, {
        timestamp: Date.now(),
        speaker: 'assistant',
        text: responseText.trim(),
      });
      logger.transcript(session.callId, 'assistant', responseText.trim());
    }
    session.responseTextBuffers.delete(responseId);

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

  if (itemType === 'function_call' && itemId && name) {
    if (!session.heardUser) {
      logCallLifecycle(session.callId, 'tool_call_blocked_pre_speech', {
        itemId,
        name,
      });
      if (responseId) {
        session.ws.send(
          JSON.stringify({ type: 'response.cancel', response_id: responseId })
        );
        session.activeResponses.delete(responseId);
      }
      return;
    }
    session.pendingTools.set(itemId, { name, argsBuffer: '' });
    logCallLifecycle(session.callId, 'tool_call_registered', { itemId, name });
  }
}

function logInputTranscript(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const transcript = getString(event.transcript);
  if (transcript) {
    logTranscript(session.callId, transcript);
    logCallLifecycle(session.callId, 'transcript_completed', {
      text: truncate(transcript, 160),
    });

    // Track transcript in analytics
    analytics.recordTranscript(session.callId, {
      timestamp: Date.now(),
      speaker: 'user',
      text: transcript,
    });

    // Enhanced logging
    logger.transcript(session.callId, 'user', transcript);

    if (!session.heardUser) {
      session.heardUser = true;
      session.bargeGuardUntil = 0;
      unlockTools(session, 'transcript');
    }
  }
}

function handleAssistantTranscriptDelta(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const delta = getString(event.delta);
  const itemId = getString(event.item_id);

  if (delta && itemId) {
    const current = session.assistantTranscriptBuffers.get(itemId) || '';
    session.assistantTranscriptBuffers.set(itemId, current + delta);

    logCallLifecycle(session.callId, 'assistant_transcript_delta', {
      text: truncate(delta, 160),
      itemId,
    });
  }
}

function handleAssistantTranscriptDone(
  session: CallSession,
  event: Record<string, unknown>
): void {
  const itemId = getString(event.item_id);
  const transcript = itemId
    ? session.assistantTranscriptBuffers.get(itemId)
    : getString(event.transcript);

  if (transcript) {
    logCallLifecycle(session.callId, 'assistant_transcript_completed', {
      text: truncate(transcript, 160),
      itemId,
    });

    // Track transcript in analytics
    analytics.recordTranscript(session.callId, {
      timestamp: Date.now(),
      speaker: 'assistant',
      text: transcript,
    });

    // Enhanced logging
    logger.transcript(session.callId, 'assistant', transcript);

    // Clean up buffer
    if (itemId) {
      session.assistantTranscriptBuffers.delete(itemId);
    }
  }
}

function extractTextFromPart(part: Record<string, unknown>): string {
  const partType = getString(part.type);
  if (partType === 'text') {
    return getString(part.text) || '';
  }
  if (partType === 'audio') {
    return getString(part.transcript) || '';
  }
  return '';
}

function extractMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  let messageText = '';

  for (const part of content) {
    if (isRecord(part)) {
      messageText += extractTextFromPart(part);
    }
  }

  return messageText.trim();
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
  const type = getString(item.type);

  // Record assistant message transcripts
  if (role === 'assistant' && type === 'message') {
    const messageText = extractMessageText(item);
    if (messageText.length > 0) {
      analytics.recordTranscript(session.callId, {
        timestamp: Date.now(),
        speaker: 'assistant',
        text: messageText,
      });
      logger.transcript(session.callId, 'assistant', messageText);
    }
  }

  // Unlock tools when user speaks
  if (role === 'user' && !session.heardUser) {
    session.heardUser = true;
    session.bargeGuardUntil = 0;
    unlockTools(session, 'conversation_item');
  }
}

function unlockTools(session: CallSession, reason: string): void {
  if (session.toolsUnlocked) {
    return;
  }
  sendSessionUpdate(session, { tool_choice: 'auto' });
  session.toolsUnlocked = true;
  logCallLifecycle(session.callId, 'tools_unlocked', { reason });
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
    logCallLifecycle(session.callId, 'response_skipped_active', {
      source: request.source,
      activeResponses: session.activeResponses.size,
      snippet,
    });
    if (config.debugLogging) {
      logger.debug(
        `Response skipped (active): ${request.source} - ${session.activeResponses.size} active`,
        { snippet }
      );
    }
    if (request.queueIfBlocked) {
      enqueueFollowUp(session, request);
    }
    return;
  }
  if (now < session.responseGateUntil) {
    logCallLifecycle(session.callId, 'response_skipped_gate', {
      source: request.source,
      waitMs: session.responseGateUntil - now,
      snippet,
    });
    if (config.debugLogging) {
      logger.debug(
        `Response skipped (gate): ${request.source} - ${session.responseGateUntil - now}ms remaining`,
        { snippet }
      );
    }
    if (request.queueIfBlocked) {
      enqueueFollowUp(session, request);
    }
    return;
  }

  const response: Record<string, unknown> = {
    instructions: request.instructions,
  };
  session.ws.send(JSON.stringify({ type: 'response.create', response }));
  logCallLifecycle(session.callId, 'response_enqueued', {
    source: request.source,
    snippet,
  });
  logger.call(session.callId, `Response enqueued: ${request.source}`, {
    snippet,
  });
  analytics.recordResponse(session.callId);
  session.responseGateUntil = now + session.minGapMs;
}

function enqueueFollowUp(session: CallSession, request: ResponseRequest): void {
  session.pendingFollowUps.push({ ...request, queueIfBlocked: true });
  logCallLifecycle(session.callId, 'follow_up_queued', {
    source: request.source,
    queueLength: session.pendingFollowUps.length,
  });
  logger.call(
    session.callId,
    `Follow-up queued: ${request.source} (queue: ${session.pendingFollowUps.length})`
  );
}

function flushPendingFollowUps(session: CallSession): void {
  if (session.pendingFollowUps.length === 0) {
    return;
  }
  const next = session.pendingFollowUps.shift();
  if (next) {
    logger.call(
      session.callId,
      `Flushing follow-up: ${next.source} (${session.pendingFollowUps.length} remaining)`
    );
    maybeRespond(session, next);
  }
}

function requestTurnResponse(session: CallSession): void {
  maybeRespond(session, {
    instructions:
      'Please respond briefly and helpfully to the caller’s last statement.',
    source: 'turn_response',
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
    logCallLifecycle(session.callId, 'tool_args_delta', {
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

  if (typeof argsPayload === 'string' && argsPayload.trim().length > 0) {
    try {
      parsedArgs = JSON.parse(argsPayload);
    } catch {
      parsedArgs = {};
    }
  }

  const toolStartTime = Date.now();
  try {
    logCallLifecycle(session.callId, 'tool_dispatch', {
      name: pending.name,
      itemId,
      args: truncate(
        typeof argsPayload === 'string'
          ? argsPayload
          : JSON.stringify(parsedArgs),
        200
      ),
    });
    logger.tool(session.callId, pending.name, 'start', parsedArgs);

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

    logger.tool(session.callId, pending.name, 'success', {
      duration: toolDuration,
      output: result.output,
    });

    const functionCallId = getString(event.call_id);
    if (functionCallId) {
      sendFunctionResult(session, functionCallId, result.output);
    }

    // Track transfer if handoff_human was called
    if (pending.name === 'handoff_human') {
      analytics.setTransferReason(
        session.callId,
        (parsedArgs as { reason?: string })?.reason ?? 'unknown'
      );
    }

    // Use custom follow-up or build one that includes the result
    const followUp =
      result.followUpInstructions ??
      `The ${pending.name} tool returned this result: ${JSON.stringify(result.output)}. IMMEDIATELY speak this information to the caller now—do not wait for them to prompt you. Explain the result in natural, conversational language and offer what they should do next.`;

    logger.call(session.callId, `Sending tool follow-up for ${pending.name}`);

    maybeRespond(session, {
      instructions: followUp,
      source: 'tool_follow_up_success',
      queueIfBlocked: true,
    });
  } catch (error) {
    const toolDuration = Date.now() - toolStartTime;
    const errorMessage = error instanceof Error ? error.message : 'unknown';

    // Track failed tool call
    analytics.recordToolCall(session.callId, {
      name: pending.name,
      timestamp: toolStartTime,
      duration: toolDuration,
      success: false,
      error: errorMessage,
    });

    logger.tool(session.callId, pending.name, 'error', {
      duration: toolDuration,
      error: errorMessage,
    });

    console.error('Tool execution failed', error);
    maybeRespond(session, {
      instructions:
        'Apologize briefly, explain that the check failed, and offer to transfer to a human right away.',
      source: 'tool_follow_up_error',
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
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
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
      JSON.stringify({ type: 'response.cancel', response_id: responseId })
    );
    logCallLifecycle(session.callId, 'response_cancel', { responseId });
  }
  session.activeResponses.clear();
}

if (import.meta.main) {
  const server = serve({ fetch: app.fetch, port: config.port });

  // Display impressive startup banner
  logger.banner('Azure OpenAI Realtime Voice Assistant');
  logger.success('Server started successfully', {
    url: server.url.toString(),
    port: config.port,
    model: config.model,
    voice: config.voice,
  });
  logger.info('Dashboard available at: /dashboard');
  logger.info('API endpoints:', {
    stats: '/api/stats',
    calls: '/api/calls',
    activeCalls: '/api/calls/active',
  });
  logger.separator();
  logger.info('Waiting for incoming calls...');

  // Log stats every 5 minutes
  setInterval(
    () => {
      const stats = analytics.getSystemStats();
      if (stats.totalCalls > 0) {
        logger.stats({
          activeCalls: stats.activeCalls,
          totalCalls: stats.totalCalls,
          completedCalls: stats.completedCalls,
          toolCalls: stats.totalToolCalls,
          uptime: stats.uptime,
        });
      }
    },
    5 * 60 * 1000
  );
}
