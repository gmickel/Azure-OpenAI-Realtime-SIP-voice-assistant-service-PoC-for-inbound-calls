import WebSocket from "ws";

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "alloy";

if (!API_KEY) {
  console.error("OPENAI_API_KEY missing");
  process.exit(1);
}

const WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
  MODEL
)}`;

let openedAt = 0;
let firstAudioAt = 0;
let audioBytes = 0;
let configured = false;
let triedAltVoiceField = false;

const ws = new WebSocket(WS_URL, {
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    origin: "https://api.openai.com",
  },
});

function sendSessionUpdate(useAltVoiceField: boolean) {
  const session: Record<string, unknown> = {
    type: "realtime",
    instructions: "Keep replies very short.",
  };

  if (useAltVoiceField) {
    session.audio = { output: { voice: VOICE } };
  } else {
    session.voice = VOICE;
  }

  ws.send(JSON.stringify({ type: "session.update", session }));
}

ws.on("open", () => {
  openedAt = Date.now();
  sendSessionUpdate(false);

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Greet briefly in one short sentence.",
      },
    })
  );
});

type EventPayload = Record<string, unknown> & { type?: string };

ws.on("message", (buf) => {
  const parsed = safeParseJson(buf.toString("utf8"));
  if (!parsed) {
    return;
  }
  handleEvent(parsed);
});

function safeParseJson(data: string): EventPayload | undefined {
  try {
    const obj = JSON.parse(data);
    return obj && typeof obj === "object" ? (obj as EventPayload) : undefined;
  } catch {
    return;
  }
}

function handleEvent(event: EventPayload): void {
  switch (event.type) {
    case "session.updated":
      configured = true;
      return;
    case "response.audio.delta":
    case "response.output_audio.delta":
      handleAudioDelta(event);
      return;
    case "response.done":
    case "response.completed":
      handleResponseCompleted();
      return;
    case "error":
      handleError(event);
      return;
    default:
      if (event.error) {
        handleError(event);
      }
  }
}

function handleAudioDelta(event: EventPayload): void {
  if (!firstAudioAt) {
    firstAudioAt = Date.now();
  }

  let delta = "";
  if (typeof event.delta === "string") {
    delta = event.delta;
  } else if (typeof event.data === "string") {
    delta = event.data;
  }
  audioBytes += Buffer.from(delta, "base64").length;
}

function handleResponseCompleted(): void {
  const ttfb = firstAudioAt ? firstAudioAt - openedAt : -1;
  console.log(
    JSON.stringify(
      {
        ok: audioBytes > 0,
        configured,
        model: MODEL,
        voice: VOICE,
        time_to_first_audio_ms: ttfb,
        total_audio_bytes: audioBytes,
      },
      null,
      2
    )
  );
  ws.close();
  process.exit(audioBytes > 0 ? 0 : 1);
}

function handleError(event: EventPayload): void {
  const err = (event.error || event) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : undefined;
  const errType = typeof err.type === "string" ? err.type : undefined;
  const param = typeof err.param === "string" ? err.param : undefined;

  if (
    (code === "unknown_parameter" || errType === "unknown_parameter") &&
    (param === "session.voice" || param === "voice") &&
    !triedAltVoiceField
  ) {
    triedAltVoiceField = true;
    sendSessionUpdate(true);
    return;
  }

  console.error("Realtime error", JSON.stringify(event, null, 2));
  process.exit(1);
}

ws.on("close", (code, reason) => {
  if (!audioBytes) {
    console.error("WS closed without audio.", code, reason?.toString?.());
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("WS error", err);
  process.exit(1);
});
