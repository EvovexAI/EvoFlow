// 侧栏工作流运行行的纯模型。
// 输入是 sessions-index 下发的 workflowActivity 与渲染端的已确认集合，输出是「画哪几行、每行几盏灯」。
// 无时钟、无 DOM：已结束的行何时折叠只看确认集合，不看时间。
import type {
  SessionWorkflowActivity,
  SessionWorkflowPhaseSummary,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { bandOf, foldPhaseBands, trackOf } from "../components/workflow-timeline/timeline-bands.js";

/** 一个会话最多画的运行行数；其余折成「+n」。 */
const WORKFLOW_RUN_LINE_MAX_LINES = 2;
/** 迷你轨道最多画的站点数；更多时折到运行站 ±2 并带「+n」尾。 */
const WORKFLOW_RUN_RAIL_MAX_STATIONS = 6;
/** 折叠时保留在运行站两侧的站点数。 */
const RAIL_FOLD_RADIUS = 2;

export interface WorkflowRunRailStation {
  name: string;
  status: SessionWorkflowPhaseSummary["status"];
  /** 进入本站的那一段轨道是否已被控制流走过（强色段）。 */
  reached: boolean;
  /**
   * 进入本站的那一段是**双线段**：本站与前一站同属一条带、却在不同轨道上，控制流没有从那站
   * 走到这站——两者是并行的。
   * 标志挂在**站**上而不是段上，所以它能活过下面的窗口折叠。
   */
  twin?: true;
}

export interface WorkflowRunRail {
  stations: WorkflowRunRailStation[];
  /** 被折叠掉、不画的站点数（「+n」尾）；0 时不画尾。 */
  hidden: number;
  /** 脚本没有阶段词汇表：画一个隐含站点「Workflow」。 */
  implicit: boolean;
}

/** 控制流是否到过这一站：running / done / failed 都算。 */
function isWorkflowRunStationReached(status: SessionWorkflowPhaseSummary["status"]): boolean {
  return status !== "pending";
}

/**
 * 迷你轨道的折叠：≤ 6 站全画；更多时以运行站为中心（没有运行站就取最后一个到过的站，再没有就取首站）
 * 保留 ±2 共 5 站，其余合成「+n」尾。这是**固定窗口**而不是滚动：侧栏没有横向手势。
 */
export function foldWorkflowRunRail(
  phases: readonly SessionWorkflowPhaseSummary[],
): WorkflowRunRail {
  if (phases.length === 0) {
    return { stations: [], hidden: 0, implicit: true };
  }
  // 折带必须在**全表**上做：窗口只取其中一段，而带是声明序上的连通分量，按窗口内的下标重折
  // 会把跨窗口边界的带拆断。折完再窗口化，双线段标志随站走。
  const bands = foldPhaseBands(
    phases.length,
    phases.map((phase) => phase.alongside ?? []),
  );
  const all: WorkflowRunRailStation[] = phases.map((phase, index) => {
    const band = index === 0 ? undefined : bandOf(bands, index);
    const twin =
      band !== undefined &&
      band === bandOf(bands, index - 1) &&
      trackOf(bands, index) !== trackOf(bands, index - 1);
    return {
      name: phase.name,
      status: phase.status,
      reached: isWorkflowRunStationReached(phase.status),
      ...(twin ? { twin: true as const } : {}),
    };
  });
  if (all.length <= WORKFLOW_RUN_RAIL_MAX_STATIONS) {
    return { stations: all, hidden: 0, implicit: false };
  }
  let anchor = all.findIndex((station) => station.status === "running");
  if (anchor < 0) {
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]!.reached) {
        anchor = index;
        break;
      }
    }
  }
  if (anchor < 0) anchor = 0;
  const windowSize = RAIL_FOLD_RADIUS * 2 + 1;
  let start = Math.max(0, anchor - RAIL_FOLD_RADIUS);
  const end = Math.min(all.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  const stations = all.slice(start, end);
  return { stations, hidden: all.length - stations.length, implicit: false };
}

/** 并行阶段之间的连接词：同时在跑的几站并排，而不是排队。 */
const WORKFLOW_RUN_PARALLEL_SEPARATOR = " ∥ ";

/**
 * 同时在跑的站名，连成 tooltip 里的一段。并行时「当前阶段」不再是一个站——谁都不比谁更当前，
 * 所以那一段换成全部在跑的站名。
 *
 * 只有一个（或零个）站在跑时返回 `undefined`：调用方退回 `currentPhase`，文案一字不变。
 */
export function workflowRunParallelPhaseLabel(
  phases: readonly SessionWorkflowPhaseSummary[],
): string | undefined {
  const running = phases.filter((phase) => phase.status === "running");
  return running.length > 1
    ? running.map((phase) => phase.name).join(WORKFLOW_RUN_PARALLEL_SEPARATOR)
    : undefined;
}

interface WorkflowRunLineSelection {
  lines: SessionWorkflowRunSummary[];
  /** 没画出来的行数（「+n」词）。 */
  overflow: number;
}

/**
 * 选出要画的行：在跑的永远画；已结束的只在**未确认**时画（确认 = 会话被打开过）。
 * 输入顺序已由投影排好（在跑的按启动序在前，其后最近结束的），这里只过滤与截断。
 */
export function selectWorkflowRunLines(
  activity: SessionWorkflowActivity | undefined,
  isAcknowledged: (runId: string) => boolean,
): WorkflowRunLineSelection {
  if (activity === undefined) return { lines: [], overflow: 0 };
  const visible = activity.runs.filter(
    (run) => isSessionWorkflowRunLive(run.status) || !isAcknowledged(run.runId),
  );
  return {
    lines: visible.slice(0, WORKFLOW_RUN_LINE_MAX_LINES),
    overflow: Math.max(0, visible.length - WORKFLOW_RUN_LINE_MAX_LINES),
  };
}

/** 已结束（可被确认）的 run id：打开会话时整批确认。 */
export function settledWorkflowRunIds(activity: SessionWorkflowActivity | undefined): string[] {
  if (activity === undefined) return [];
  return activity.runs
    .filter((run) => !isSessionWorkflowRunLive(run.status))
    .map((run) => run.runId);
}

/** 在跑的 run 数（收起的项目组头旁的脉冲灯与数量）。 */
export function countLiveWorkflowRuns(activity: SessionWorkflowActivity | undefined): number {
  if (activity === undefined) return 0;
  return activity.runs.filter((run) => isSessionWorkflowRunLive(run.status)).length;
}
