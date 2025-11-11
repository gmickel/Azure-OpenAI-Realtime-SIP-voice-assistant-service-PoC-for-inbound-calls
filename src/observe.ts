/* eslint-disable no-console */
const phoneRegex = /\+?\d[\d().\-\s]{6,}\d/g;
const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactPII(value: string): string {
  return value
    .replace(emailRegex, "[REDACTED]")
    .replace(phoneRegex, "[REDACTED]");
}

export function logWebhook(eventType: string, payload: unknown): void {
  console.info(
    JSON.stringify({
      scope: "webhook",
      eventType,
      payload,
    })
  );
}

export function logTranscript(callId: string, transcript: string): void {
  console.info(
    JSON.stringify({
      scope: "transcript",
      callId,
      text: redactPII(transcript),
    })
  );
}

export function logToolEvent(
  callId: string,
  tool: string,
  status: "start" | "success" | "error",
  meta: Record<string, unknown> = {}
): void {
  console.info(
    JSON.stringify({
      scope: "tool",
      callId,
      tool,
      status,
      meta,
    })
  );
}

export function logCallLifecycle(
  callId: string,
  status: string,
  meta: Record<string, unknown> = {}
): void {
  console.info(
    JSON.stringify({
      scope: "call",
      callId,
      status,
      meta,
    })
  );
}
