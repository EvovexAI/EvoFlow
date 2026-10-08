// ZCode Protocol v4 Snapshot — verbatim copy from ZCode/packages/shared/src/zcode-protocol-v4/snapshot.ts
import { z } from "zod";
import { conversationRowSchema } from "./rows.js";

export const sessionControlSchema = z.object({
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
});
export type SessionControl = z.infer<typeof sessionControlSchema>;

export const sessionMetaStateSchema = z.object({
  title: z.string(),
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

export const sessionUsageStateSchema = z.object({
  contextWindow: z.object({
    usedTokens: z.number(),
    maxTokens: z.number(),
  }).nullable(),
  cumulative: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
});
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

export const queueStateSchema = z.object({
  items: z.array(z.object({
    intent: z.string(),
    dispatch: z.object({
      state: z.enum(["queued", "reserved", "promoting"]),
    }),
  })),
  autoDrain: z.boolean(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

export const rowsWindowSchema = z.object({
  window: z.array(conversationRowSchema),
  totalCount: z.number(),
  firstRowId: z.number().nullable(),
});
export type RowsWindow = z.infer<typeof rowsWindowSchema>;

export const conversationSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  sessionId: z.string(),
  logEpoch: z.string(),
  seq: z.number(),
  revision: z.number(),
  control: sessionControlSchema,
  meta: sessionMetaStateSchema,
  usage: sessionUsageStateSchema,
  queue: queueStateSchema,
  rows: rowsWindowSchema,
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
