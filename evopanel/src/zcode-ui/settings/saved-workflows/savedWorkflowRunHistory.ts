// 运行历史的归组与呈现。
// 归属只按 `dwf_run.name === 工作流名`；模型另起名字的 run 不归任何工作流，而不是猜。
import type { ZCodeSavedWorkflowRun, ZCodeSavedWorkflowRunStatus } from "@zcode/shared";

/** 每个名字下 `updatedAt` 最新的一行（服务端按 time_updated 倒序，这里只取首见）。 */
export function lastRunByWorkflowName(
  runs: readonly ZCodeSavedWorkflowRun[],
): Map<string, ZCodeSavedWorkflowRun> {
  const byName = new Map<string, ZCodeSavedWorkflowRun>();
  const sorted = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const run of sorted) {
    if (run.name === undefined || byName.has(run.name)) continue;
    byName.set(run.name, run);
  }
  return byName;
}

type SavedWorkflowRunBadgeKind = "completed" | "errored" | "running" | "stopped" | "never";

/**
 * 卡片「上次运行」徽标的四态 + 「尚未运行」。pending 与 running 同画成活动态。
 * 终态词汇为 errored / stopped；老 CLI 仍可能发
 * `failed` / `cancelled`，按同一语义折进去而不是让徽标缺席。
 */
export function savedWorkflowRunBadgeKind(
  status: ZCodeSavedWorkflowRunStatus | "errored" | "stopped" | "failed" | "cancelled" | undefined,
): SavedWorkflowRunBadgeKind {
  switch (status) {
    case undefined:
      return "never";
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "errored";
    case "stopped":
    case "cancelled":
      return "stopped";
  }
}

/** 运行历史行的实参芯片：`key=value`，值按 JSON 压缩。 */
export function formatSavedWorkflowRunArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  return Object.entries(args).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** 一次 run 的时长（毫秒）；非终态按 now 计。 */
export function savedWorkflowRunDurationMs(run: ZCodeSavedWorkflowRun, now: number): number {
  const end = run.status === "pending" || run.status === "running" ? now : run.updatedAt;
  return Math.max(0, end - run.createdAt);
}

export function formatSavedWorkflowTokens(spent: number): string {
  if (!Number.isFinite(spent)) return "—";
  if (spent >= 1_000_000) return `${(spent / 1_000_000).toFixed(1)}M`;
  if (spent >= 1_000) return `${(spent / 1_000).toFixed(1)}k`;
  return String(Math.round(spent));
}
