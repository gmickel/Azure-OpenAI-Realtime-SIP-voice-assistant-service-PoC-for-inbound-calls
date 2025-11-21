import { serve } from 'bun';
import { Hono } from 'hono';
import OpenAI from 'openai';
import WebSocket from 'ws';
import { analytics } from './analytics';
import { acceptCall, type RealtimeSessionConfig } from './callflow';
import { config } from './config';
import { renderDashboard } from './dashboard-template';
import { logger } from './logger';
import { logCallLifecycle, logTranscript, logWebhook } from './observe';
import { greetingPrompt, systemPrompt } from './prompts';
import { realtimeToolSchemas, runTool } from './tools';
import { extractCallerPhone } from './utils';

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

// Tunable timings tuned for Azure SIP responsiveness
const TURN_RESPONSE_DELAY_MS = 150;
const GREETING_BARGE_GUARD_MS = 2000;
const DEFAULT_MIN_RESPONSE_GAP_MS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const truncate = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/**
 * Generates a summary description of a realtime event for logging.
 */
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
    const latency = analytics.markAssistantResponse(session.callId);
    if (latency !== undefined) {
      logCallLifecycle(session.callId, 'latency_measured_ms', { latency });
    }
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
    const latency = analytics.markAssistantResponse(session.callId);
    if (latency !== undefined) {
      logCallLifecycle(session.callId, 'latency_measured_ms', { latency });
    }
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
  analytics.markUserTurnStart(session.callId);
  if (session.pendingTurnTimer) {
    clearTimeout(session.pendingTurnTimer);
  }
  session.pendingTurnTimer = setTimeout(() => {
    requestTurnResponse(session);
    session.pendingTurnTimer = undefined;
  }, TURN_RESPONSE_DELAY_MS);
  logCallLifecycle(session.callId, 'turn_timer_scheduled', {
    delayMs: TURN_RESPONSE_DELAY_MS,
  });
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
          try {
            const stats = analytics.getSystemStats();
            const activeCalls = analytics.getActiveCalls();
            const recentCalls = analytics.getRecentCalls(5);

            const data = JSON.stringify({ stats, activeCalls, recentCalls });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          } catch (error) {
            logger.warning('SSE dashboard payload failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        };

        const heartbeat = () => {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        };

        // Send initial data
        sendUpdate();

        // Send updates every 2 seconds
        const interval = setInterval(sendUpdate, 2000);
        const heartbeatInterval = setInterval(heartbeat, 15_000);

        // Cleanup on close
        const cleanup = () => {
          clearInterval(interval);
          clearInterval(heartbeatInterval);
          controller.close();
        };

        c.req.raw.signal?.addEventListener('abort', () => {
          cleanup();
        });
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    }
  );
});

// Real-time dashboard endpoint
app.get('/dashboard', (c) => {
  const stats = analytics.getSystemStats();
  const activeCalls = analytics.getActiveCalls();
  const recentCalls = analytics.getRecentCalls(5);

  return c.html(renderDashboard(stats, activeCalls, recentCalls));
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
    const sipHeaders = Array.isArray(data?.sip_headers)
      ? data?.sip_headers
      : [];
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

/**
 * Orchestrates the incoming call setup.
 * 1. Starts analytics
 * 2. Accepts the call with Azure SIP
 * 3. Attaches the WebSocket sideband for Realtime API control
 */
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

/**
 * Establishes the WebSocket connection to the OpenAI Realtime API.
 * Handles the session initialization, event routing, and lifecycle management.
 */
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
    minGapMs: DEFAULT_MIN_RESPONSE_GAP_MS,
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
      session.bargeGuardUntil = Date.now() + GREETING_BARGE_GUARD_MS;
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

    try {
      await routeRealtimeEvent(session, parsed);
    } catch (error) {
      logger.error('Realtime event handling failed', error);
      logCallLifecycle(session.callId, 'rt_event_error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
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

/**
 * Routes incoming WebSocket events to the appropriate handler.
 */
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
    const latency = analytics.markAssistantResponse(session.callId);
    if (latency !== undefined) {
      logCallLifecycle(session.callId, 'latency_measured_ms', { latency });
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
    analytics.markUserTurnStart(session.callId);

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
