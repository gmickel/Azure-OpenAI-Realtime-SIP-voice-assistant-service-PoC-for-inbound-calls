import { config } from './config';

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

function isAzure() {
  return config.openaiBaseUrl.includes('.openai.azure.com');
}

const TRAILING_SLASH_REGEX = /\/$/;

function addApiVersion(url: string) {
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

async function postAbs(
  url: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  const common: Record<string, string> = {
    'content-type': 'application/json',
    ...(headers || {}),
  };
  if (isAzure()) {
    common['api-key'] = config.apiKey;
  } else {
    common.authorization = `Bearer ${config.apiKey}`;
  }

  console.log('🔗 API Request:', { url, apiVersion: config.apiVersion });

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

export async function acceptCall(
  callId: string,
  session: RealtimeSessionConfig
): Promise<void> {
  const body = { ...session, model: config.model, type: 'realtime' };
  await postAbs(acceptUrl(callId), body);
}

export async function referCall(
  callId: string,
  targetUri: string
): Promise<void> {
  await postAbs(referUrl(callId), { target_uri: targetUri });
}

export async function hangupCall(callId: string): Promise<void> {
  await postAbs(hangupUrl(callId));
}
