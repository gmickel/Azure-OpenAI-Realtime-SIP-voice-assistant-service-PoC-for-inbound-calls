import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  REALTIME_MODEL: z.string().trim().min(1).default("gpt-realtime"),
  REALTIME_VOICE: z.string().trim().min(1).default("marin"),
  SIP_TARGET_URI: z.string().trim().optional(),
  PORT: z.coerce.number().int().positive().default(8000),
  OPENAI_BASE: z.string().url().optional(),
  REALTIME_WS_BASE: z.string().url().optional(),
  TEST_MODE: z.enum(["0", "1"]).optional(),
  REALTIME_API_VERSION: z.string().trim().optional(),
});

export type RuntimeConfig = {
  apiKey: string;
  webhookSecret: string;
  model: string;
  voice: string;
  sipTargetUri?: string;
  port: number;
  openaiBaseUrl: string;
  realtimeWsUrl: string;
  testMode: boolean;
  apiVersion?: string;
  isAzure: boolean;
};

const defaultRealtimeWs = "wss://api.openai.com/v1/realtime";
const defaultOpenAIBase = "https://api.openai.com";

export function loadConfig(): RuntimeConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join(", ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  const {
    OPENAI_API_KEY,
    OPENAI_WEBHOOK_SECRET,
    REALTIME_MODEL,
    REALTIME_VOICE,
    SIP_TARGET_URI,
    PORT,
    OPENAI_BASE,
    REALTIME_WS_BASE,
    TEST_MODE,
    REALTIME_API_VERSION,
  } = parsed.data;

  const testMode = TEST_MODE === "1";

  if (!(OPENAI_API_KEY || testMode)) {
    throw new Error("OPENAI_API_KEY is required");
  }
  if (!(OPENAI_WEBHOOK_SECRET || testMode)) {
    throw new Error("OPENAI_WEBHOOK_SECRET is required");
  }

  const openaiBaseUrl = OPENAI_BASE || defaultOpenAIBase;
  const isAzure = openaiBaseUrl.includes(".openai.azure.com");

  return {
    apiKey: OPENAI_API_KEY ?? "",
    webhookSecret: OPENAI_WEBHOOK_SECRET ?? "",
    model: REALTIME_MODEL || "gpt-realtime",
    voice: REALTIME_VOICE || "marin",
    sipTargetUri: SIP_TARGET_URI,
    port: PORT ?? 8000,
    openaiBaseUrl,
    realtimeWsUrl: REALTIME_WS_BASE || defaultRealtimeWs,
    testMode,
    apiVersion: REALTIME_API_VERSION,
    isAzure,
  };
}

export const config = loadConfig();
