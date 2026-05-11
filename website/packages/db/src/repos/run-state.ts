import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
]);
export const localeSchema = z.enum(["zh", "en"]);

export const storedWorkerHeartbeatSchema = z.object({
  updatedAt: z.string(),
  workerId: z.string().trim().min(1),
});

export const storedJobRunSchema = z.object({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  error: z.string().nullable(),
  id: z.string().trim().min(1),
  jobId: z.string().trim().min(1),
  locale: localeSchema,
  logLines: z.array(z.string()),
  observabilityRecorded: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.string().nullable(),
  status: runStatusSchema,
  workerId: z.string().nullable(),
});

export const storedEvolutionRunSchema = z.object({
  action: z.string().trim().min(1),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  error: z.string().nullable(),
  id: z.string().trim().min(1),
  locale: localeSchema,
  logLines: z.array(z.string()),
  observabilityRecorded: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.string().nullable(),
  status: runStatusSchema,
  workerId: z.string().nullable(),
});

export const storedJobRunStateSchema = z.object({
  runs: z.array(storedJobRunSchema),
  workers: z.array(storedWorkerHeartbeatSchema),
});

export const storedEvolutionRunStateSchema = z.object({
  runs: z.array(storedEvolutionRunSchema),
});

export type RunStatus = z.infer<typeof runStatusSchema>;
export type Locale = z.infer<typeof localeSchema>;
export type StoredWorkerHeartbeat = z.infer<typeof storedWorkerHeartbeatSchema>;
export type StoredJobRun = z.infer<typeof storedJobRunSchema>;
export type StoredEvolutionRun = z.infer<typeof storedEvolutionRunSchema>;

export const MAX_RUNS = 40;
export const MAX_LOG_LINES = 12;
export const STALE_WORKER_WINDOW_MS = 60_000;

export function normalizeLogLines(lines: string[]) {
  return [...lines.filter((line) => line !== "_"), "_"].slice(-MAX_LOG_LINES);
}

export function createRunId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function pruneWorkers(
  workers: StoredWorkerHeartbeat[],
  nowMs: number,
) {
  return workers.filter((worker) => {
    const updatedAtMs = Date.parse(worker.updatedAt);

    if (!Number.isFinite(updatedAtMs)) {
      return false;
    }

    return nowMs - updatedAtMs <= STALE_WORKER_WINDOW_MS;
  });
}

export function coerceJsonRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function coerceStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

export function coerceTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
