/**
 * 底部 SessionChildWorkIcons（execution/state.childWorks）→ 对话进度卡同源投影。
 *
 * 图标亮 ≠ V4 snapshot.workflowRuns 已到：childWorks 在 app_runner 注册时就亮，
 * platform→workflowRuns upsert 可能晚到或根本没进 hub。这里把 active workflow
 * childWorks 投影成 WorkflowRunState，供轮尾 digest / join 与图标同一数据源。
 */
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@zcode/ui/ToolCallBlocks/shared.js";
import { projectCollabToWorkflowRun } from "@zcode/ui/lib/collabToWorkflowProjection.js";
import type { SessionChildWorkItem } from "../react/lib/session-reattach.js";
import { isChildWorkActive } from "../react/hooks/useSessionChildWorks.js";
// note: @zcode/ui paths resolve via evopanel vite/tsconfig to vendored zcode-ui

const ACTIVE = new Set(["pending", "running"]);

function readExtraTaskId(work: SessionChildWorkItem): string {
  const extra = work.extra && typeof work.extra === "object" ? work.extra : null;
  if (!extra) return "";
  return String(
    (extra as { task_id?: unknown }).task_id ||
      (extra as { taskId?: unknown }).taskId ||
      (extra as { mainTaskId?: unknown }).mainTaskId ||
      "",
  ).trim();
}

export function isActiveWorkflowChildWork(work: SessionChildWorkItem): boolean {
  if (String(work.kind || "").trim() !== "workflow") return false;
  return isChildWorkActive(work.status) || ACTIVE.has(String(work.status || "").trim().toLowerCase());
}

export type ChildWorkWorkflowProjection = {
  /** runId ≡ collab mainTaskId（右栏 / digest 打开键） */
  runId: string;
  run: WorkflowRunState;
  summary: WorkflowRunCardSummary;
  name: string;
  workId: string;
  runRefId: string;
};

/** active workflow childWorks → 协议 run（无子节点时也能出「运行中」卡）。 */
export function projectActiveWorkflowChildWorks(
  works: readonly SessionChildWorkItem[] | null | undefined,
): ChildWorkWorkflowProjection[] {
  const out: ChildWorkWorkflowProjection[] = [];
  const seen = new Set<string>();
  for (const work of works ?? []) {
    if (!isActiveWorkflowChildWork(work)) continue;
    const taskId = readExtraTaskId(work);
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    const name =
      String(work.title || "").trim() ||
      String((work.extra as { app_name?: string } | null)?.app_name || "").trim() ||
      "工作流";
    const projected = projectCollabToWorkflowRun({
      mainTask: {
        taskId,
        name,
        status: String(work.status || "running"),
      },
      subtasks: [],
      runId: taskId,
      name,
    });
    if (!projected) continue;
    out.push({
      runId: taskId,
      run: projected.run,
      summary: projected.summary,
      name: projected.name || name,
      workId: String(work.workId || "").trim(),
      runRefId: String(work.refId || "").trim(),
    });
  }
  return out;
}

/** childWorks（execution/state，3s 新鲜）里 workflow 项的 runId(taskId) → 原始状态。 */
export function childWorkStatusById(
  works: readonly SessionChildWorkItem[] | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const work of works ?? []) {
    if (String(work.kind || "").trim() !== "workflow") continue;
    const taskId = readExtraTaskId(work);
    const status = String(work.status || "").trim().toLowerCase();
    if (!taskId || !status || map.has(taskId)) continue;
    map.set(taskId, status);
  }
  return map;
}

const CHILD_WORK_TERMINAL_RUN_STATUS: Record<string, WorkflowRunState["status"]> = {
  completed: "completed",
  success: "completed",
  done: "completed",
  failed: "errored",
  fail: "errored",
  error: "errored",
  errored: "errored",
  timeout: "errored",
  cancelled: "stopped",
  canceled: "stopped",
  stopped: "stopped",
  interrupted: "stopped",
};

const EMPTY_WORKFLOW_RUNS: WorkflowRunState[] = [];

/** 把 childWorks 投影合并进 snapshot.workflowRuns（同 runId 以 snapshot 为准）。 */
export function mergeWorkflowRunsWithChildWorks(
  snapshotRuns: readonly WorkflowRunState[] | undefined,
  childProjections: readonly ChildWorkWorkflowProjection[],
  childWorkStatuses?: ReadonlyMap<string, string>,
): WorkflowRunState[] {
  const byId = new Map<string, WorkflowRunState>();
  for (const run of snapshotRuns ?? []) {
    const id = String(run.runId || "").trim();
    if (id) byId.set(id, run);
  }
  for (const row of childProjections) {
    if (byId.has(row.runId)) continue;
    byId.set(row.runId, row.run);
  }
  if (childWorkStatuses && childWorkStatuses.size > 0) {
    // execution/state 已判终态的 run 压过陈旧 running 快照：无 mirror 喂流的
    // 后台 run 终态不会进 hub 投影（终态收口在服务端 catchup/reconcile 里），
    // 卡片不能拿着冻结的 running 一直转（2026-11-15 员工任务实锤）。
    // 反方向（快照已终态、轮询还说 running）保持 snapshot 权威，避免抖动。
    for (const [runId, workStatus] of childWorkStatuses) {
      const run = byId.get(runId);
      if (!run) continue;
      const status = String(run.status || "").trim().toLowerCase();
      if (status !== "pending" && status !== "running") continue;
      const terminal = CHILD_WORK_TERMINAL_RUN_STATUS[workStatus];
      if (!terminal) continue;
      byId.set(runId, { ...run, status: terminal });
    }
  }
  if (byId.size === 0) return EMPTY_WORKFLOW_RUNS;
  return [...byId.values()];
}

export function childWorkProjectionsToSummariesByRunId(
  childProjections: readonly ChildWorkWorkflowProjection[],
): Map<string, WorkflowRunCardSummary> {
  const map = new Map<string, WorkflowRunCardSummary>();
  for (const row of childProjections) {
    const { settled, total } = workflowRunStepCounts(row.run);
    map.set(row.runId, {
      ...row.summary,
      runId: row.runId,
      nodesSettled: settled,
      nodesTotal: total,
      run: row.run,
    });
  }
  return map;
}
