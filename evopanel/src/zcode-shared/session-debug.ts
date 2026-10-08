import { z } from "zod";

export const SESSION_DEBUG_LIMITS = { rounds: 200, network: 100, dedupe: 2000 } as const;
export const sessionDebugParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();
const count = z.number().finite().nonnegative();
const debugUsageSchema = z
  .object({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    totalTokens: count.optional(),
    reasoningTokens: count.optional(),
    cachedInputTokens: count.optional(),
    cachedWriteInputTokens: count.optional(),
  })
  .strict();
export const sessionDebugRoundSchema = z
  .object({
    eventKey: z.string(),
    requestId: z.string(),
    requestIndex: count,
    recordedAt: count,
    usage: debugUsageSchema,
    hitRate: count.nullable(),
    generationDurationMs: count.nullable(),
    tokensPerSecond: count.nullable(),
  })
  .strict();
export const sessionDebugNetworkEntrySchema = z
  .object({
    eventKey: z.string(),
    traceId: z.string(),
    recordedAt: count,
    statusType: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    requestId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    providerKind: z.string().optional(),
    transport: z.string().optional(),
    baseURL: z.string().optional(),
    querySource: z.string().optional(),
    queryId: z.string().optional(),
    timestamp: z.string().optional(),
    attempt: count.optional(),
    maxAttempts: count.optional(),
    nextAttempt: count.optional(),
    retryable: z.boolean().optional(),
    statusCode: count.optional(),
    durationMs: count.optional(),
    delayMs: count.optional(),
    idleMs: count.optional(),
    timeoutMs: count.optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestHeaderCount: count,
    responseHeaderCount: count,
  })
  .strict();
export const sessionDebugSnapshotSchema = z
  .object({
    sessionId: z.string(),
    rounds: z.array(sessionDebugRoundSchema).max(SESSION_DEBUG_LIMITS.rounds),
    networkEntries: z.array(sessionDebugNetworkEntrySchema).max(SESSION_DEBUG_LIMITS.network),
    cache: z
      .object({
        hitRateRequestCount: count,
        totalInputTokens: count,
        totalCacheReadTokens: count,
        hitRate: count.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SessionDebugSnapshot = z.infer<typeof sessionDebugSnapshotSchema>;
export type SessionDebugNetworkEntry = z.infer<typeof sessionDebugNetworkEntrySchema>;

/** 输出 token 与首输出到请求结束的同源时间；未知值不能用请求总耗时替代。 */
export function calculateOutputTps(
  outputTokens: number | undefined,
  generationDurationMs: number | null,
): number | null {
  if (
    outputTokens === undefined ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    generationDurationMs === null ||
    !Number.isFinite(generationDurationMs) ||
    generationDurationMs <= 0
  )
    return null;
  const tps = (outputTokens * 1000) / generationDurationMs;
  return Number.isFinite(tps) ? tps : null;
}
