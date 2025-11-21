import { config } from './config';
import { logger } from './logger';

export type RealtimeSessionConfig = {
  type: 'realtime';
  model: string; // must be your deployment name on Azure, e.g. gpt-realtime
  voice?: string;
  instructions?: string;
  turn_detection?: { type: 'server_vad'; interrupt_response: boolean };
  input_audio_transcription?: { model: string };
  tools: Record<string, unknown>[];
  tool_choice?: 'auto' | 'required' | 'none';
};

const TRAILING_SLASH_REGEX = /\/$/;

function isAzure(): boolean {
  return config.openaiBaseUrl.includes('.openai.azure.com');
}

function addApiVersion(url: string): string {
  if (!config.apiVersion) {
    return url;
  }
  const u = new URL(url);
  if (!u.searchParams.has('api-version')) {
    u.searchParams.set('api-version', config.apiVersion);
  }
  return u.toString();
}

function realtimeBase(): string {
  return config.openaiBaseUrl.replace(TRAILING_SLASH_REGEX, '');
}

function acceptUrl(callId: string): string {
  const base = realtimeBase();
  const url = `${base}/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
  return isAzure() ? addApiVersion(url) : url;
}

function referUrl(callId: string): string {
  const base = realtimeBase();
  const url = `${base}/v1/realtime/calls/${encodeURIComponent(callId)}/refer`;
  return isAzure() ? addApiVersion(url) : url;
}

function hangupUrl(callId: string): string {
  const base = realtimeBase();
  const url = `${base}/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`;
  return isAzure() ? addApiVersion(url) : url;
}

/**
 * Helper to make authenticated requests to the OpenAI Realtime API.
 */
async function makeOpenAIRequest(
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<void> {
  const common: Record<string, string> = {
    'content-type': 'application/json',
    ...(headers || {}),
  };

  if (isAzure()) {
    common['api-key'] = config.apiKey;
  } else {
    common.authorization = `Bearer ${config.apiKey}`;
  }

  logger.debug('API Request', { url, apiVersion: config.apiVersion });

  const res = await fetch(url, {
    method: 'POST',
    headers: common,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI request failed (${res.status}): ${detail}`);
  }
}

/**
 * Accepts an incoming call by posting to the /accept endpoint.
 */
export async function acceptCall(
  callId: string,
  session: RealtimeSessionConfig
): Promise<void> {
  const body = { ...session, model: config.model, type: 'realtime' };
  await makeOpenAIRequest(acceptUrl(callId), body);
}

/**
 * Refers (transfers) a call to a new SIP URI.
 */
export async function referCall(
  callId: string,
  targetUri: string
): Promise<void> {
  await makeOpenAIRequest(referUrl(callId), { target_uri: targetUri });
}

/**
 * Hangs up an active call.
 */
export async function hangupCall(callId: string): Promise<void> {
  await makeOpenAIRequest(hangupUrl(callId));
}
