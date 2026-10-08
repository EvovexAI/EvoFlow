export type ZCodeBackgroundTaskControlStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "lost";

export interface ZCodeBackgroundTaskControlItem {
  jobId: string;
  toolCallId?: string;
  command: string;
  taskKind: "agent" | "bash";
  cancellable?: boolean;
  title?: string;
  status: ZCodeBackgroundTaskControlStatus;
  startedAt?: number;
  elapsedMs?: number;
  pid?: number;
  stdoutTail?: string;
  stderrTail?: string;
  outputTail?: string;
  raw?: unknown;
}

const ACTIVE_BACKGROUND_TASK_CONTROL_STATUSES = new Set<ZCodeBackgroundTaskControlStatus>([
  "running",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function readNumberField(value: unknown, keys: readonly string[]): number | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readBooleanField(value: unknown, keys: readonly string[]): boolean | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "no" || normalized === "0") {
        return false;
      }
    }
  }
  return undefined;
}

function readInstantMs(value: unknown, keys: readonly string[]): number | undefined {
  const numberValue = readNumberField(value, keys);
  if (numberValue !== undefined) {
    return numberValue;
  }
  if (!isPlainRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function commandFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

function readCommand(record: Record<string, unknown>): string | undefined {
  const direct =
    commandFromValue(record.command) ??
    commandFromValue(record.cmd) ??
    commandFromValue(record.script);
  if (direct) {
    return direct;
  }
  const input = isPlainRecord(record.input) ? record.input : null;
  return input
    ? (commandFromValue(input.command) ??
        commandFromValue(input.cmd) ??
        commandFromValue(input.script))
    : undefined;
}

function normalizeToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_") ?? ""
  );
}

type BackgroundTaskControlKind = ZCodeBackgroundTaskControlItem["taskKind"];

function taskKindFromToken(token: string): BackgroundTaskControlKind | undefined {
  if (
    token === "agent" ||
    token === "local_agent" ||
    token === "subagent" ||
    token === "background_agent"
  ) {
    return "agent";
  }
  if (
    token === "bash" ||
    token === "local_bash" ||
    token === "shell" ||
    token === "terminal" ||
    token === "background_bash" ||
    token === "background_shell"
  ) {
    return "bash";
  }
  return undefined;
}

function readExplicitTaskKind(
  record: Record<string, unknown>,
): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(
    readStringField(record, ["taskKind", "task_kind", "taskType", "task_type"]),
  );
  return taskKindFromToken(token);
}

function readToolTaskKind(record: Record<string, unknown>): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(readStringField(record, ["toolName", "tool_name"]));
  if (token === "task") {
    return "agent";
  }
  return taskKindFromToken(token);
}

function readBackgroundTypeTaskKind(
  record: Record<string, unknown>,
): BackgroundTaskControlKind | undefined {
  const token = normalizeToken(readStringField(record, ["type", "kind", "category"]));
  if (
    token === "local_agent" ||
    token === "subagent" ||
    token === "background_agent" ||
    token === "agent_background"
  ) {
    return "agent";
  }
  if (
    token === "local_bash" ||
    token === "background_bash" ||
    token === "background_shell" ||
    token === "bash_background" ||
    token === "shell_background"
  ) {
    return "bash";
  }
  return undefined;
}

function resolveTaskKind(record: Record<string, unknown>): BackgroundTaskControlKind | undefined {
  return (
    readExplicitTaskKind(record) ?? readToolTaskKind(record) ?? readBackgroundTypeTaskKind(record)
  );
}

/**
 * 旧 background task 事件的唯一 kind 兼容入口。
 * 新协议应直接携带 taskKind；只有历史记录缺字段时才从工具名/类型别名恢复。
 */
export function resolveZCodeBackgroundTaskControlKind(
  value: unknown,
): BackgroundTaskControlKind | undefined {
  return isPlainRecord(value) ? resolveTaskKind(value) : undefined;
}

function readDisplayCommand(
  record: Record<string, unknown>,
  taskKind: BackgroundTaskControlKind,
): string | undefined {
  if (taskKind === "agent") {
    return (
      readStringField(record, ["description", "summary", "title", "label"]) ?? readCommand(record)
    );
  }
  return (
    readCommand(record) ?? readStringField(record, ["description", "summary", "title", "label"])
  );
}

function normalizeStatus(value: string | undefined): ZCodeBackgroundTaskControlStatus {
  const normalized = normalizeToken(value);
  if (
    normalized === "queued" ||
    normalized === "scheduled" ||
    normalized === "starting" ||
    normalized === "pending"
  ) {
    return "pending";
  }
  if (
    normalized === "running" ||
    normalized === "in_progress" ||
    normalized === "started" ||
    normalized === "active"
  ) {
    return "running";
  }
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "error" ||
    normalized === "spawn_error"
  ) {
    return "failed";
  }
  if (
    normalized === "killed" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "stopped" ||
    normalized === "terminated" ||
    normalized === "timed_out" ||
    normalized === "timeout"
  ) {
    return "killed";
  }
  if (normalized === "lost" || normalized === "unknown") {
    return "lost";
  }
  return "running";
}

function readJobId(record: Record<string, unknown>, command: string): string {
  const explicitId = readStringField(record, [
    // ZCode Protocol 后台任务取消入口按 taskId 查找 runtime task 记录；
    // 若这里落到 toolCallId，UI 会发送 call_*，后端只能返回 background_task_not_found。
    "taskId",
    "task_id",
    "backgroundTaskId",
    "background_task_id",
    "jobId",
    "job_id",
    "backgroundJobId",
    "background_job_id",
    "id",
  ]);
  if (explicitId) {
    return explicitId;
  }
  const startedAt = readInstantMs(record, ["startedAt", "started_at", "startTime", "start_time"]);
  const pid = readNumberField(record, ["pid", "processId", "process_id"]);
  return `background-task:${pid ?? "no-pid"}:${startedAt ?? "no-start"}:${command}`;
}

export function parseZCodeBackgroundTaskControlItems(
  value: unknown,
): ZCodeBackgroundTaskControlItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const jobsById = new Map<string, ZCodeBackgroundTaskControlItem>();
  for (const item of value) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const taskKind = resolveZCodeBackgroundTaskControlKind(item);
    if (!taskKind) {
      continue;
    }
    const command = readDisplayCommand(item, taskKind);
    if (!command) {
      continue;
    }
    const jobId = readJobId(item, command);
    const toolCallId = readStringField(item, ["toolCallId", "tool_call_id"]);
    const startedAt = readInstantMs(item, ["startedAt", "started_at", "startTime", "start_time"]);
    const elapsedMs = readNumberField(item, [
      "elapsedMs",
      "elapsed_ms",
      "durationMs",
      "duration_ms",
    ]);
    const pid = readNumberField(item, ["pid", "processId", "process_id"]);
    const title = readStringField(item, ["title", "name", "label", "description"]);
    const status = normalizeStatus(readStringField(item, ["status", "state", "phase"]));
    const cancellable = readBooleanField(item, ["cancellable"]);
    const stdoutTail = readStringField(item, ["stdoutTail", "stdout_tail"]);
    const stderrTail = readStringField(item, ["stderrTail", "stderr_tail"]);
    const outputTail = readStringField(item, ["outputTail", "output_tail"]);
    const job: ZCodeBackgroundTaskControlItem = {
      jobId,
      ...(toolCallId ? { toolCallId } : {}),
      command,
      taskKind,
      ...(cancellable !== undefined ? { cancellable } : {}),
      ...(title ? { title } : {}),
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(stdoutTail ? { stdoutTail } : {}),
      ...(stderrTail ? { stderrTail } : {}),
      ...(outputTail ? { outputTail } : {}),
      raw: item,
    };
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}

export function isActiveZCodeBackgroundTaskControlItem(
  job: ZCodeBackgroundTaskControlItem,
): boolean {
  return ACTIVE_BACKGROUND_TASK_CONTROL_STATUSES.has(job.status);
}

export function getZCodeBackgroundTaskControlItemElapsedMs(
  job: ZCodeBackgroundTaskControlItem,
  now = Date.now(),
): number {
  const elapsedFromStart =
    job.startedAt !== undefined ? Math.max(0, now - job.startedAt) : undefined;
  return Math.max(elapsedFromStart ?? 0, job.elapsedMs ?? 0);
}

export function collectVisibleZCodeBackgroundTaskControlItems(
  jobs: readonly ZCodeBackgroundTaskControlItem[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ZCodeBackgroundTaskControlItem & { elapsedMs: number }> {
  return jobs
    .filter(isActiveZCodeBackgroundTaskControlItem)
    .map((job) => ({
      ...job,
      elapsedMs: getZCodeBackgroundTaskControlItemElapsedMs(job, now),
    }))
    .filter((job) => job.elapsedMs >= thresholdMs)
    .sort((left, right) => right.elapsedMs - left.elapsedMs);
}
