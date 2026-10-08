import { z } from "zod";
import { browserBackendDescriptorSchema } from "./backend.js";
import { browserCommandSchema } from "./commands.js";
import { browserCommandResultSchema } from "./result.js";

export const NODE_REPL_BROWSER_BROKER_SOCKET_ENV = "ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET";
export const NODE_REPL_BROWSER_BROKER_TOKEN_ENV = "ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN";

const requestBase = z.object({
  id: z.string().uuid(),
  runtimeScope: z.enum(["main", "subagent"]),
  token: z.string().min(32),
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1).optional(),
  trace: z
    .object({
      traceId: z.string().trim().min(1),
      spanId: z.string().trim().min(1).optional(),
      parentSpanId: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
});

export const nodeReplBrowserBrokerRequestSchema = z.discriminatedUnion("op", [
  requestBase.extend({ op: z.literal("list") }).strict(),
  requestBase
    .extend({
      op: z.literal("execute"),
      browserId: z.string().trim().min(1),
      browserGeneration: z.number().int().nonnegative(),
      command: browserCommandSchema,
    })
    .strict(),
]);
export type NodeReplBrowserBrokerRequest = z.infer<typeof nodeReplBrowserBrokerRequestSchema>;

export const nodeReplBrowserBrokerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(true),
      browsers: z.array(browserBackendDescriptorSchema).optional(),
      result: browserCommandResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);
export type NodeReplBrowserBrokerResponse = z.infer<typeof nodeReplBrowserBrokerResponseSchema>;
