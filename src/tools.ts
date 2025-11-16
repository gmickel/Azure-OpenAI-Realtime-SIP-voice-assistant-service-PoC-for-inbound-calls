import { z } from 'zod';
import { referCall } from './callflow';
import { config } from './config';
import { logToolEvent } from './observe';

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
  reason: z.string().min(3).describe('Why the caller needs a human'),
});

const lookupSchema = z.object({
  orderNumber: z
    .string()
    .min(4)
    .max(32)
    .regex(/^[A-Z0-9-]+$/i)
    .describe('Customer-provided order number (e.g., ACME-12345)'),
});

const inventorySchema = z.object({
  sku: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Z0-9-]+$/i)
    .describe('Product SKU or short identifier'),
});

const callbackSchema = z.object({
  reason: z.string().min(5).describe('What the human should help with'),
  preferredTime: z
    .string()
    .min(3)
    .describe("Desired callback window (e.g., 'tomorrow 10am')"),
});

const weatherSchema = z.object({
  location: z
    .string()
    .min(2)
    .describe("City or location name (e.g., 'Stockholm', 'New York')"),
});

const companyHoursSchema = z.object({
  department: z
    .string()
    .optional()
    .describe("Specific department (e.g., 'sales', 'support')"),
});

const productSearchSchema = z.object({
  query: z
    .string()
    .min(2)
    .describe('Product name or description to search for'),
  category: z
    .string()
    .optional()
    .describe("Product category (e.g., 'electronics', 'clothing')"),
});

const storeLocationSchema = z.object({
  zipCode: z
    .string()
    .optional()
    .describe('ZIP code or postal code for location search'),
});

const definitions: ToolDefinition[] = [
  {
    name: 'handoff_human',
    description: 'Transfers the caller to a live human queue.',
    schema: handoffSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'Short sentence describing why the caller needs a human.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx) => {
      const typedArgs = handoffSchema.parse(args);
      if (!config.sipTargetUri) {
        throw new Error('SIP_TARGET_URI is not configured');
      }

      await referCall(ctx.callId, config.sipTargetUri);
      return {
        output: {
          status: 'transferring',
          target_uri: config.sipTargetUri,
          reason: typedArgs.reason,
        },
        followUpInstructions:
          'Let the caller know you’re transferring them now and to please hold.',
      };
    },
  },
  {
    name: 'lookup_order',
    description: 'Retrieves the latest order status for a caller.',
    schema: lookupSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        orderNumber: {
          type: 'string',
          description: "The caller's order number (letters+digits).",
        },
      },
      required: ['orderNumber'],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = lookupSchema.parse(args);
      const now = new Date();
      return {
        output: {
          orderNumber: typedArgs.orderNumber,
          status: 'processing',
          last_updated: now.toISOString(),
          eta_days: 2,
        },
        followUpInstructions: `Let the caller know order ${typedArgs.orderNumber} is processing and should ship within about 2 days.`,
      };
    },
  },
  {
    name: 'check_inventory',
    description:
      'Checks if a product is in stock and estimates delivery timing.',
    schema: inventorySchema,
    jsonSchema: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description: 'SKU, article ID, or product name fragment.',
        },
      },
      required: ['sku'],
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
    name: 'schedule_callback',
    description: 'Books a human callback with the provided context.',
    schema: callbackSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the customer needs a callback.',
        },
        preferredTime: {
          type: 'string',
          description: 'Desired timeslot (free text).',
        },
      },
      required: ['reason', 'preferredTime'],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = callbackSchema.parse(args);
      return {
        output: {
          status: 'scheduled',
          reference: `CB-${Math.floor(Date.now() / 1000)}`,
          reason: typedArgs.reason,
          preferredTime: typedArgs.preferredTime,
        },
        followUpInstructions:
          "Confirm the agreed callback window, share the reference number, and ask if there's anything else to handle.",
      };
    },
  },
  {
    name: 'get_weather',
    description:
      'Provides current weather and forecast for a specified location.',
    schema: weatherSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or location name to get weather for.',
        },
      },
      required: ['location'],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = weatherSchema.parse(args);
      // Demo data - in production, call a real weather API
      const conditions = ['sunny', 'partly cloudy', 'cloudy', 'rainy'];
      const condition =
        conditions[Math.floor(Math.random() * conditions.length)];
      const temp = Math.floor(Math.random() * 20) + 10; // 10-30°C
      const humidity = Math.floor(Math.random() * 40) + 40; // 40-80%

      return {
        output: {
          location: typedArgs.location,
          temperature_celsius: temp,
          temperature_fahrenheit: Math.round((temp * 9) / 5 + 32),
          condition,
          humidity_percent: humidity,
          forecast: `${condition} conditions expected to continue`,
        },
        followUpInstructions: `Share the weather for ${typedArgs.location}: ${temp}°C (${Math.round((temp * 9) / 5 + 32)}°F) and ${condition}. Ask if they need anything else.`,
      };
    },
  },
  {
    name: 'check_company_hours',
    description:
      'Retrieves business hours for the company or a specific department.',
    schema: companyHoursSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        department: {
          type: 'string',
          description: 'Optional department name (sales, support, etc.).',
        },
      },
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = companyHoursSchema.parse(args);
      const dept = typedArgs.department || 'general';

      const generalHours = {
        weekday: '9:00 AM - 5:00 PM',
        weekend: 'Closed on weekends',
      };

      const hours: Record<string, { weekday: string; weekend: string }> = {
        sales: { weekday: '9:00 AM - 6:00 PM', weekend: '10:00 AM - 4:00 PM' },
        support: {
          weekday: '8:00 AM - 8:00 PM',
          weekend: '9:00 AM - 5:00 PM',
        },
        general: generalHours,
      };

      const deptHours = hours[dept.toLowerCase()] ?? generalHours;

      return {
        output: {
          department: dept,
          weekday_hours: deptHours.weekday,
          weekend_hours: deptHours.weekend,
          timezone: 'CET',
          currently_open:
            new Date().getHours() >= 9 && new Date().getHours() < 17,
        },
        followUpInstructions: `Let the caller know ${dept} hours are ${deptHours.weekday} on weekdays and ${deptHours.weekend} on weekends. Ask if there's anything else you can help with.`,
      };
    },
  },
  {
    name: 'search_products',
    description:
      'Searches the product catalog and recommends items based on query.',
    schema: productSearchSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product search query.',
        },
        category: {
          type: 'string',
          description: 'Optional category filter.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = productSearchSchema.parse(args);

      // Demo data - in production, query real product database
      const demoProducts = [
        { name: 'Premium Wireless Headphones', price: 299, rating: 4.5 },
        { name: 'Smart Watch Pro', price: 399, rating: 4.7 },
        { name: 'Portable Speaker', price: 149, rating: 4.3 },
      ];

      const results = demoProducts.slice(0, 2); // Return top 2

      return {
        output: {
          query: typedArgs.query,
          category: typedArgs.category || 'all',
          results_count: results.length,
          top_matches: results,
          total_available: demoProducts.length,
        },
        followUpInstructions: `Share the top product matches: ${results.map((p) => `${p.name} at $${p.price}`).join(', ')}. Ask if they'd like details on any specific item or help with ordering.`,
      };
    },
  },
  {
    name: 'find_store_location',
    description: 'Finds the nearest store location based on ZIP code or area.',
    schema: storeLocationSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        zipCode: {
          type: 'string',
          description: 'ZIP/postal code for location search.',
        },
      },
      additionalProperties: false,
    },
    handler: (args: unknown) => {
      const typedArgs = storeLocationSchema.parse(args);

      // Demo data - in production, query real store database
      const stores = [
        {
          name: 'Downtown Store',
          address: '123 Main Street',
          distance_km: 2.5,
          phone: '+1-555-0100',
        },
        {
          name: 'Mall Location',
          address: '456 Shopping Center',
          distance_km: 5.2,
          phone: '+1-555-0200',
        },
      ];

      const nearestStore = stores[0];
      if (!nearestStore) {
        throw new Error('No store locations available');
      }

      return {
        output: {
          search_area: typedArgs.zipCode || 'your area',
          nearest_store: nearestStore,
          additional_locations: stores.length - 1,
          stores,
        },
        followUpInstructions: `Share that the nearest store is ${nearestStore.name} at ${nearestStore.address}, about ${nearestStore.distance_km}km away. Provide the phone number ${nearestStore.phone}. Ask if they need directions or hours.`,
      };
    },
  },
];

const toolMap = new Map(definitions.map((tool) => [tool.name, tool]));

export const realtimeToolSchemas = definitions.map((tool) => ({
  type: 'function',
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

  logToolEvent(ctx.callId, name, 'start');
  const parsedArgs = tool.schema.parse(rawArgs);

  try {
    const result = await tool.handler(parsedArgs, ctx);
    logToolEvent(ctx.callId, name, 'success');
    return result;
  } catch (error) {
    logToolEvent(ctx.callId, name, 'error', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}
