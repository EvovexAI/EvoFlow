import { z } from "zod";

export const LOCAL_TTFT_STAGES = [
  "renderer_prepare",
  "command_admission",
  "execution_wait",
  "request_prepare",
  "model_request",
  "output_return",
] as const;
export const LOCAL_TTFT_BUCKETS_MS = [
  1, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000,
];
export const LOCAL_TTFT_MAX_DETAILS = 64;
export const LOCAL_TTFT_PREPARATION_STAGES = [
  "context",
  "hooks",
  "persistence",
  "compaction",
  "mcp",
  "tools",
  "request_assembly",
] as const;
const diagnosticTime = z.number().finite().nonnegative();
export const localTtftDetailSchema = z
  .object({
    id: z.string().min(1).max(128),
    stage: z.enum([...LOCAL_TTFT_PREPARATION_STAGES, "attempt", "retry_wait", "user_confirmation"]),
    start: diagnosticTime,
    end: diagnosticTime.optional(),
    outcome: z.enum(["completed", "failed", "cancelled", "first_output"]).optional(),
    requestId: z.string().min(1).max(128).optional(),
    logicalCallId: z.string().min(1).max(128).optional(),
    role: z.enum(["response", "preparation"]).optional(),
    source: z.enum(["renderer", "cli"]),
  })
  .strict()
  .refine((value) => value.end === undefined || value.end >= value.start);
export type LocalTtftDetail = z.infer<typeof localTtftDetailSchema>;
export const LOCAL_TTFT_MAX_PENDING = 128;
export const LOCAL_TTFT_TTL_MS = 300_000;
export const LOCAL_TTFT_CLOCK_MAX_ERROR_MS = 10;
export const LOCAL_TTFT_CLOCK_TTL_MS = 60_000;
const time = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(128);
export const localTtftContextSchema = z
  .object({ version: z.literal(1), observationId: z.string().uuid() })
  .strict();
export type LocalTtftContext = z.infer<typeof localTtftContextSchema>;
export const localTtftClockSchema = z
  .object({ instanceId: identifier, receivedAt: time, sentAt: time })
  .strict();
export type LocalTtftClock = z.infer<typeof localTtftClockSchema>;
export interface LocalTtftCalibration {
  instanceId: string;
  offsetMs: number;
  errorMs: number;
  measuredAt: number;
}
export function calibrateLocalTtftClock(
  start: number,
  end: number,
  clock: LocalTtftClock,
): LocalTtftCalibration | undefined {
  const networkMs = end - start - (clock.sentAt - clock.receivedAt);
  if (
    ![start, end, clock.receivedAt, clock.sentAt].every(Number.isFinite) ||
    end < start ||
    clock.sentAt < clock.receivedAt ||
    networkMs < 0 ||
    networkMs / 2 > LOCAL_TTFT_CLOCK_MAX_ERROR_MS
  )
    return undefined;
  return {
    instanceId: clock.instanceId,
    offsetMs: (start + end - clock.receivedAt - clock.sentAt) / 2,
    errorMs: networkMs / 2,
    measuredAt: end,
  };
}
export const localTtftOutputKindSchema = z.enum(["text", "reasoning", "tool"]);
export type LocalTtftOutputKind = z.infer<typeof localTtftOutputKindSchema>;
export const localTtftFactsSchema = z
  .object({
    ...localTtftContextSchema.shape,
    instanceId: identifier,
    commandId: identifier,
    sessionId: identifier.optional(),
    turnId: identifier.optional(),
    productTurnId: identifier.optional(),
    queryId: identifier.optional(),
    requestId: identifier.optional(),
    logicalCallId: identifier.optional(),
    cliVersion: identifier.optional(),
    provider: identifier.optional(),
    model: identifier.optional(),
    details: z.array(localTtftDetailSchema).max(LOCAL_TTFT_MAX_DETAILS).optional(),
    truncated: z.boolean().optional(),
    revision: z.number().int().nonnegative().optional(),
    sendMode: z.enum(["idle", "queued", "guided"]).optional(),
    clockInvalid: z.boolean().optional(),
    receivedAt: time,
    admittedAt: time.optional(),
    executionAt: time.optional(),
    requestAt: time.optional(),
    outputAt: time.optional(),
    outputKind: localTtftOutputKindSchema.optional(),
    terminal: z.enum(["completed", "failed", "cancelled", "rejected", "interrupted"]).optional(),
    excluded: z.enum(["busy", "retry", "unsupported", "failed", "capacity"]).optional(),
  })
  .strict();
export type LocalTtftFacts = z.infer<typeof localTtftFactsSchema>;
export const localTtftIntervalSchema = z
  .object({
    stage: z.enum(LOCAL_TTFT_STAGES),
    start: time,
    end: time,
    source: z.enum(["renderer", "cli", "aligned"]),
  })
  .strict()
  .refine((interval) => interval.end >= interval.start);
export const localTtftRecordSchema = z
  .object({
    version: z.literal(1),
    observationId: z.string().uuid(),
    commandId: identifier.optional(),
    sessionId: identifier.optional(),
    turnId: identifier.optional(),
    productTurnId: identifier.optional(),
    queryId: identifier.optional(),
    requestId: identifier.optional(),
    logicalCallId: identifier.optional(),
    cliVersion: identifier.optional(),
    cliInstanceId: identifier.optional(),
    kind: z.enum(["start", "first_output", "first_text", "no_text", "excluded", "checkpoint"]),
    outcome: z.enum([
      "success",
      "busy",
      "retry",
      "unsupported",
      "failed",
      "cancelled",
      "background",
      "expired",
      "capacity",
      "recovery",
      // 桌面 continuous 缓冲溢出/投影重建后的 online snapshot；不是手机 replayable 恢复。
      "resync",
      "clock_invalid",
      "rejected",
      "interrupted",
      "guided",
      "unclosed",
    ]),
    start: time,
    end: time,
    firstOutputKind: localTtftOutputKindSchema.optional(),
    quality: z.enum(["complete", "missing", "clock_invalid"]),
    clockErrorMs: time.optional(),
    intervals: z.array(localTtftIntervalSchema).max(6),
    checkpointId: identifier.optional(),
    details: z.array(localTtftDetailSchema).max(LOCAL_TTFT_MAX_DETAILS).optional(),
    truncated: z.boolean().optional(),
    sendMode: z.enum(["idle", "queued", "guided"]).optional(),
    visibility: z.enum(["foreground", "background", "background_returned"]).optional(),
    visibilityChanges: z
      .array(z.object({ at: time, foreground: z.boolean() }).strict())
      .max(32)
      .optional(),
    userWaitMs: time.optional(),
    executionMs: time.optional(),
    timingReliable: z.boolean().optional(),
    cliTimingReliable: z.boolean().optional(),
    provider: identifier.optional(),
    model: identifier.optional(),
  })
  .strict()
  .refine((record) => record.end >= record.start);
export type LocalTtftRecord = z.infer<typeof localTtftRecordSchema>;
export const localTtftBatchSchema = z
  .object({
    version: z.literal(1),
    rendererInstanceId: identifier,
    sequence: z.number().int().nonnegative(),
    records: z.array(localTtftRecordSchema).max(32),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type LocalTtftBatch = z.infer<typeof localTtftBatchSchema>;
export function localTtftNow(): number {
  return performance.timeOrigin + performance.now();
}
