// ZCode Protocol v4 Rows — verbatim copy from ZCode/packages/shared/src/zcode-protocol-v4/rows.ts
import { z } from "zod";

const rowBaseFields = {
  rowId: z.number(),
  turnId: z.string(),
  entityId: z.string().min(1).optional(),
  productTurnId: z.string().min(1).optional(),
  visibility: z.literal("visible").optional(),
  createdAt: z.number(),
  createdAtSeq: z.number(),
  actions: z
    .object({
      canFork: z.literal(true).optional(),
      canEdit: z.literal(true).optional(),
      canRetry: z.literal(true).optional(),
      canRewindFiles: z.literal(true).optional(),
      editDisposition: z.enum(["rewind", "fork"]).optional(),
    })
    .optional(),
} as const;

export const turnHeaderRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("turnHeader"),
  origin: z.enum([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  executionKind: z.enum(["agent", "controlOnly"]).optional(),
  sourceCommandId: z.string().optional(),
  historyRoundCount: z.number().int().nonnegative().optional(),
  state: z.enum(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  activeMs: z.number().optional(),
  workSegments: z.array(z.object({
    segmentId: z.string().min(1),
    triggerEntityId: z.string().min(1).optional(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    activeMs: z.number().nonnegative().optional(),
  })).optional(),
  originMeta: z.object({
    backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
    workId: z.string().optional(),
  }).optional(),
  workflowLaunch: z.object({
    runId: z.string(),
    nodeId: z.string(),
    parentSessionId: z.string().optional(),
  }).optional(),
  fileChanges: z.object({
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    state: z.enum(["active", "reverted"]).optional(),
  }).optional(),
});
export type TurnHeaderRow = z.infer<typeof turnHeaderRowSchema>;

export const userInputRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("userInput"),
  text: z.string(),
  epilogueStart: z.number().int().nonnegative().optional(),
  origin: z.enum([
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ]),
  originMeta: z.object({
    backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
    workId: z.string().optional(),
    senderSessionId: z.string().optional(),
    senderLabel: z.string().optional(),
  }).optional(),
  workflowLaunch: z.object({
    runId: z.string(),
    nodeId: z.string(),
    parentSessionId: z.string().optional(),
  }).optional(),
  guided: z.literal(true).optional(),
  sourceCommandId: z.string().optional(),
  rootSourceCommandId: z.string().optional(),
  clientId: z.string().optional(),
  attachments: z.array(z.object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    previewRef: z.string().optional(),
  })).optional(),
});
export type UserInputRow = z.infer<typeof userInputRowSchema>;

export const assistantTextRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("assistantText"),
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted", "failed"]),
  model: z.string().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
});
export type AssistantTextRow = z.infer<typeof assistantTextRowSchema>;

export const reasoningRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("reasoning"),
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted"]),
  durationMs: z.number().optional(),
});
export type ReasoningRow = z.infer<typeof reasoningRowSchema>;

export const toolOutputSchema = z.object({
  kind: z.enum(["text", "error"]),
  text: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const toolCallRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("toolCall"),
  assistantResponseId: z.string().min(1).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"]),
  inputText: z.string(),
  input: z.unknown().optional(),
  output: toolOutputSchema.optional(),
  display: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  approvalInteractionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
});
export type ToolCallRow = z.infer<typeof toolCallRowSchema>;

export const conversationRowSchema = z.discriminatedUnion("kind", [
  turnHeaderRowSchema,
  userInputRowSchema,
  assistantTextRowSchema,
  reasoningRowSchema,
  toolCallRowSchema,
]);
export type ConversationRow = z.infer<typeof conversationRowSchema>;
export type ConversationRowKind = ConversationRow["kind"];
