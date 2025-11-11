import { z } from "zod";
import { referCall } from "./callflow";
import { config } from "./config";
import { logToolEvent } from "./observe";

export type ToolExecutionResult = {
  output: Record<string, unknown>;
  followUpInstructions?: string;
};

export type ToolContext = { callId: string };
type MaybePromise<T> = T | Promise<T>;

type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  handler: (
    args: unknown,
    ctx: ToolContext
  ) => MaybePromise<ToolExecutionResult>;
};

const handoffSchema = z.object({
  reason: z.string().min(3).describe("Why the caller needs a human"),
});

const lookupSchema = z.object({
  orderNumber: z
    .string()
    .min(4)
    .max(32)
    .regex(/^[A-Z0-9-]+$/i)
    .describe("Customer-provided order number (e.g., ACME-12345)"),
});

const inventorySchema = z.object({
  sku: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Z0-9-]+$/i)
    .describe("Product SKU or short identifier"),
});

const callbackSchema = z.object({
  reason: z.string().min(5).describe("What the human should help with"),
  preferredTime: z
    .string()
    .min(3)
    .describe("Desired callback window (e.g., 'tomorrow 10am')"),
});

const definitions: ToolDefinition[] = [
  {
    name: "handoff_human",
    description: "Transfers the caller to a live human queue.",
    schema: handoffSchema,
    jsonSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Short sentence describing why the caller needs a human.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx) => {
      const typedArgs = handoffSchema.parse(args);
      if (!config.sipTargetUri) {
        throw new Error("SIP_TARGET_URI is not configured");
      }

      await referCall(ctx.callId, config.sipTargetUri);
      return {
        output: {
          status: "transferring",
          target_uri: config.sipTargetUri,
          reason: typedArgs.reason,
        },
        followUpInstructions:
          "Let the caller know you’re transferring them now and to please hold.",
      };
    },
  },
  {
    name: "lookup_order",
    description: "Retrieves the latest order status for a caller.",
    schema: lookupSchema,
    jsonSchema: {
      type: "object",
      properties: {
        orderNumber: {
          type: "string",
          description: "The caller's order number (letters+digits).",
        },
      },
      required: ["orderNumber"],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = lookupSchema.parse(args);
      const now = new Date();
      return {
        output: {
          orderNumber: typedArgs.orderNumber,
          status: "processing",
          last_updated: now.toISOString(),
          eta_days: 2,
        },
        followUpInstructions: `Let the caller know order ${typedArgs.orderNumber} is processing and should ship within about 2 days.`,
      };
    },
  },
  {
    name: "check_inventory",
    description:
      "Checks if a product is in stock and estimates delivery timing.",
    schema: inventorySchema,
    jsonSchema: {
      type: "object",
      properties: {
        sku: {
          type: "string",
          description: "SKU, article ID, or product name fragment.",
        },
      },
      required: ["sku"],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = inventorySchema.parse(args);
      const available = Math.random() > 0.25;
      const quantity = available ? Math.floor(Math.random() * 8) + 1 : 0;
      return {
        output: {
          sku: typedArgs.sku.toUpperCase(),
          available,
          quantity,
          eta_days: available ? 2 : 6,
        },
        followUpInstructions: available
          ? `Confirm item ${typedArgs.sku.toUpperCase()} is in stock (qty ${quantity}) and offer express shipping within ~2 days.`
          : `Explain that item ${typedArgs.sku.toUpperCase()} is currently unavailable, mention a ~6-day restock, and offer alternatives or a callback.`,
      };
    },
  },
  {
    name: "schedule_callback",
    description: "Books a human callback with the provided context.",
    schema: callbackSchema,
    jsonSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the customer needs a callback.",
        },
        preferredTime: {
          type: "string",
          description: "Desired timeslot (free text).",
        },
      },
      required: ["reason", "preferredTime"],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = callbackSchema.parse(args);
      return {
        output: {
          status: "scheduled",
          reference: `CB-${Math.floor(Date.now() / 1000)}`,
          reason: typedArgs.reason,
          preferredTime: typedArgs.preferredTime,
        },
        followUpInstructions:
          "Confirm the agreed callback window, share the reference number, and ask if there’s anything else to handle.",
      };
    },
  },
];

const toolMap = new Map(definitions.map((tool) => [tool.name, tool]));

export const realtimeToolSchemas = definitions.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.jsonSchema,
}));

export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    throw new Error(`Unsupported tool: ${name}`);
  }

  logToolEvent(ctx.callId, name, "start");
  const parsedArgs = tool.schema.parse(rawArgs);

  try {
    const result = await tool.handler(parsedArgs, ctx);
    logToolEvent(ctx.callId, name, "success");
    return result;
  } catch (error) {
    logToolEvent(ctx.callId, name, "error", {
      message: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}
