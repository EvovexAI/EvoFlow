// ZCode Protocol v4 Delta — verbatim copy from ZCode/packages/shared/src/zcode-protocol-v4/delta.ts
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";

export const statePatchSchema = z.object({
  revision: z.number().optional(),
  control: z.object({
    phase: z.enum(["draft", "prewarming", "running", "completedSuccess", "completedInterrupted", "error"]),
    sessionEnded: z.boolean(),
    canStop: z.boolean(),
    stopState: z.enum(["idle", "stoppable", "stopping"]),
    activeWorks: z.array(z.object({
      kind: z.enum(["primaryTurn", "foregroundSubagent", "compact", "goalVerifier", "goalContinuation", "turnSteer"]),
      foregroundExecutionId: z.string().min(1).optional(),
      startedAt: z.number(),
    })),
    lastError: z.object({
      code: z.string(),
      message: z.string(),
      recoverable: z.boolean(),
      at: z.number(),
      source: z.enum(["provider", "runtime", "tool", "network"]),
    }).nullable(),
  }).optional(),
  meta: z.object({
    title: z.string(),
    titleSource: z.enum(["default", "generated", "custom"]),
  }).optional(),
  usage: z.object({
    contextWindow: z.object({
      usedTokens: z.number(),
      maxTokens: z.number(),
    }).nullable(),
    cumulative: z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
  }).optional(),
  queue: z.object({
    items: z.array(z.object({
      intent: z.string(),
      dispatch: z.object({
        state: z.enum(["queued", "reserved", "promoting"]),
      }),
    })),
    autoDrain: z.boolean(),
  }).optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
