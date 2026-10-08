// ============================================================
// sessions-index 的工作流运行摘要
// ============================================================
// 侧栏要在会话标题下画一条「Workflow 图标 + 迷你轨道灯 + 当前 phase 名」，却不能为此订阅整个
// workflowRuns（那是 conversation 权威投影，按 run 进度高频变化）。这里把同一 snapshot 的
// `workflowRuns` + `backgroundWorks` 派生成一份**有界、只装侧栏真正读的字段**的摘要：
// 纯函数、无时钟——「已结束的行何时折叠」由渲染端的已确认集合决定，不在这里记时间。

import { z } from "zod";
import { timestampSchema } from "./core.js";
import type { BackgroundWorkSummary } from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/** 每会话最多下发的 run 数：在跑的按启动序在前，其后是最近结束的。 */
export const SESSION_WORKFLOW_ACTIVITY_MAX_RUNS = 4;

/**
 * 站点灯的四态，与卡片时间线同一词汇（`STATUS_DOT`）。控制流给出骨架：在跑时当前 phase
 * running、已进入 done、其余 pending；completed 已进入 done；errored 当前 failed；stopped 当前 pending。
 *
 * 成员节点再补一条：run 在跑时，
 * **出生在这一站**且此刻真在跑的节点把它点亮。并行阶段因此能同时烧——控制流只记得最后一个标记，
 * 而 A 的子代理在 B 的标记之后仍在干活。节点只会说「还在跑」，绝不把 done / failed / pending
 * 改成别的：失败词留给控制流。
 */
export const sessionWorkflowPhaseStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type SessionWorkflowPhaseStatus = z.infer<typeof sessionWorkflowPhaseStatusSchema>;

export const sessionWorkflowPhaseSummarySchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  status: sessionWorkflowPhaseStatusSchema,
  /**
   * 进入本站时仍在跑的其他站的**下标**（下标落在本 `phases` 数组上），来自
   * `run.phaseAlongside`。侧栏据此把并行的两站之间画成双线段。只有声明表那条路有这个事实——
   * 退化路（已进入的 phase）是按进入序拼出来的，没有并行可言，所以那时整个键缺席。
   */
  alongside: z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
});
export type SessionWorkflowPhaseSummary = z.infer<typeof sessionWorkflowPhaseSummarySchema>;

export const sessionWorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** 发起行的工具调用 id：点击运行行打开 run pane 的键；直接启动的 run 也有（`launch-` 前缀）。 */
  toolCallId: z.string().min(1).optional(),
  /** 工作流后台工作的标题（= run 的展示名）；投影里没有对应后台工作时缺席。 */
  name: z.string().min(1).optional(),
  status: workflowRunSchema.shape.status,
  stopReason: workflowRunSchema.shape.stopReason,
  /** 后台工作的开始时刻，tooltip 的 elapsed 用；没有后台工作时缺席。 */
  startedAt: timestampSchema.optional(),
  /**
   * 站点表，声明序：`run.phaseNames`（run-launched 带来的声明表）在场用它，否则退化为已进入的
   * phase + 当前 phase（进入序）。两者都没有时为空数组，UI 画一个隐含站点「Workflow」。
   */
  phases: z.array(sessionWorkflowPhaseSummarySchema).max(WORKFLOW_RUNS_LIMITS.maxPhases),
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /** status === "running" 的子代理数（tooltip 的「{n} agents working」）。 */
  agentsWorking: z.number().int().nonnegative(),
});
export type SessionWorkflowRunSummary = z.infer<typeof sessionWorkflowRunSummarySchema>;

export const sessionWorkflowActivitySchema = z.object({
  runs: z.array(sessionWorkflowRunSummarySchema).max(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS),
});
export type SessionWorkflowActivity = z.infer<typeof sessionWorkflowActivitySchema>;

export function isSessionWorkflowRunLive(status: SessionWorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running";
}

/**
 * 「这个节点此刻真在跑」：与 packages/ui 的 `statusOfRunNode` 的 running 臂逐条相同，也与
 * reducer 推 actor 三态用的那一组相同（workflow-runs-reducer.ts），所以站点灯与
 * 「{n} agents working」永远对同一件事说「在跑」。
 *
 * `dispatched` / `waiting` 不算：前者是「会话就绪、首个请求尚未准入」的短暂相位，后者在等槽位
 * 或在退避——真正发出去了由 `node-executing` 说。
 */
function isRunNodeRunning(node: WorkflowRunNode): boolean {
  return node.phase === "executing" || node.phase === "repairing" || node.phase === "nudged";
}

/**
 * 站名 ↔ 实例出生戳的关联规则。与 packages/ui 的 `phaseNameMatches`（workflow-graph/phase-name.ts）
 * 逐条相同：精确匹配，站名**恰好顶到上界**时才按前缀兜底——前缀只在截断真的发生过时才开，
 * 否则「计划」会误认「计划修复」。那个 helper 在 ui 层，shared 不能反向依赖，所以这里内联同一条规则。
 */
function phaseNameMatches(stationName: string, stamp: string): boolean {
  return (
    stationName === stamp ||
    (stationName.length >= WORKFLOW_RUNS_LIMITS.maxPhaseNameLength && stamp.startsWith(stationName))
  );
}

function derivePhases(run: WorkflowRunState): SessionWorkflowPhaseSummary[] {
  const entered = new Set((run.phases ?? []).map((phase) => phase.name));
  const current = run.currentPhase;
  let names: string[];
  // 「同时在跑」的下标说的是**声明表**里的位置，所以只有走声明表这条路时它才有意义；退化路
  // （已进入的 phase + 当前 phase）是另一个下标空间，那时整张表不带。
  let alongside: readonly (readonly number[])[] | undefined;
  if (run.phaseNames !== undefined && run.phaseNames.length > 0) {
    names = run.phaseNames;
    alongside = run.phaseAlongside;
  } else {
    names = (run.phases ?? []).map((phase) => phase.name);
    if (current !== undefined && !entered.has(current)) names = [...names, current];
  }
  const live = isSessionWorkflowRunLive(run.status);
  // 在跑的节点的出生戳。run 不在跑时整张表为空：终态 run 里没有人还在干活，哪怕某条 settled
  // 事件没来得及落下（与 actor 三态里「终态压过一切」同一姿态）。
  const burning = live
    ? run.nodes.filter(isRunNodeRunning).flatMap((node) => node.phaseName ?? [])
    : [];
  const emitted = Math.min(names.length, WORKFLOW_RUNS_LIMITS.maxPhases);
  return names.slice(0, WORKFLOW_RUNS_LIMITS.maxPhases).map((name, index) => {
    const isCurrent = name === current;
    const wasEntered = entered.has(name) || isCurrent;
    // 出生在这一站的节点还在跑 → 这一站还在烧，哪怕控制流早已走到下一个标记。
    const burningHere = burning.some((stamp) => phaseNameMatches(name, stamp));
    let status: SessionWorkflowPhaseStatus;
    if (live) {
      status = isCurrent || burningHere ? "running" : wasEntered ? "done" : "pending";
    } else if (run.status === "completed") {
      status = wasEntered ? "done" : "pending";
    } else if (run.status === "errored") {
      status = isCurrent ? "failed" : wasEntered ? "done" : "pending";
    } else {
      // stopped：控制流停在当前 phase，它没有完成也没有失败——留空心灯。
      status = isCurrent ? "pending" : wasEntered ? "done" : "pending";
    }
    // 裁表之后下标空间跟着变窄：指向被裁掉的站的引用一起丢掉，剩下空的就不建键。
    const beside = (alongside?.[index] ?? []).filter(
      (other) => Number.isInteger(other) && other >= 0 && other < emitted && other !== index,
    );
    return { name, status, ...(beside.length === 0 ? {} : { alongside: beside }) };
  });
}

function summarizeRun(
  run: WorkflowRunState,
  work: BackgroundWorkSummary | undefined,
): SessionWorkflowRunSummary {
  const name = work?.title.trim();
  return {
    runId: run.runId,
    ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
    ...(name === undefined || name.length === 0 ? {} : { name }),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(work === undefined ? {} : { startedAt: work.startedAt }),
    phases: derivePhases(run),
    ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
    agentsWorking: run.actors.filter((actor) => actor.status === "running").length,
  };
}

/**
 * 从同一 snapshot 的 `workflowRuns` + `backgroundWorks` 派生会话的工作流运行摘要。
 * 在跑的 run（pending / running）按 `runs[]` 序（= 启动序）在前；其后是已结束的，按后台工作的
 * `endedAt` 倒序、无 endedAt 时按 `runs[]` 倒序（越晚建的越新）。总数裁到 4。
 * 会话一个 run 都没有 → `undefined`（键整个缺席，旧 CLI 因此什么都不变）。
 */
export function deriveSessionWorkflowActivity(input: {
  workflowRuns: WorkflowRunsState | undefined;
  backgroundWorks: readonly BackgroundWorkSummary[];
}): SessionWorkflowActivity | undefined {
  const runs = input.workflowRuns?.runs;
  if (runs === undefined || runs.length === 0) return undefined;
  const workByRunId = new Map<string, BackgroundWorkSummary>();
  for (const work of input.backgroundWorks) {
    if (work.kind === "workflow") workByRunId.set(work.workId, work);
  }
  const live: SessionWorkflowRunSummary[] = [];
  const settled: { summary: SessionWorkflowRunSummary; endedAt: number; index: number }[] = [];
  runs.forEach((run, index) => {
    const work = workByRunId.get(run.runId);
    const summary = summarizeRun(run, work);
    if (isSessionWorkflowRunLive(run.status)) live.push(summary);
    else settled.push({ summary, endedAt: work?.endedAt ?? 0, index });
  });
  settled.sort((a, b) => b.endedAt - a.endedAt || b.index - a.index);
  return {
    runs: [...live, ...settled.map((entry) => entry.summary)].slice(
      0,
      SESSION_WORKFLOW_ACTIVITY_MAX_RUNS,
    ),
  };
}
