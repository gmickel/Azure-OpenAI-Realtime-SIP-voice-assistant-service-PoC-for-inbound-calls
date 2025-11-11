import { serve } from "bun";
import { Hono } from "hono";
import OpenAI from "openai";
import WebSocket from "ws";

import { acceptCall, type RealtimeSessionConfig } from "./callflow";
import { config } from "./config";
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
  if (!session.toolsUnlocked && Date.now() < session.bargeGuardUntil) {
    logCallLifecycle(session.callId, "barge_guard_active", {
      remainingMs: session.bargeGuardUntil - Date.now(),
    });
    return;
  }
  cancelActiveResponses(session);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("call_id_not_found")) {
      logCallLifecycle(callId, "accept_skipped", {
        reason: "call_id_not_found",
      });
      return;
    }
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
    const result = await runTool(pending.name, parsedArgs, {
      callId: session.callId,
    });

    const functionCallId = getString(event.call_id);
    if (functionCallId) {
      sendFunctionResult(session, functionCallId, result.output);
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
  console.info(`Server listening on ${server.url}`);
}
