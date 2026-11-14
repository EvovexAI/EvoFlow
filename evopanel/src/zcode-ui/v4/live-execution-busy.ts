/**
 * 忙闲对齐：control.canStop 可能已被 RUN_FINISHED / sse_final 提前关掉，
 * 但时间线仍有 streaming 正文 / running 工具卡 / 后台 bash——齿轮与停止键必须跟「还有活」走。
 *
 * 多会话切回：侧栏已 idle（hostExecuting=false）且 phase 已终态时，勿再被 FINISHED
 * 后未收口的 running 工具卡钉死画布转圈（RESULT 迟到写不进行的陈旧投影）。
 */

const LIVE_TOOL_STATUSES = new Set([
  "inputStreaming",
  "pendingApproval",
  "running",
]);

const TERMINAL_TOOL_STATUSES = new Set(["success", "error", "cancelled"]);

const STREAMING_ROW_KINDS = new Set(["assistantText", "reasoning"]);

const TERMINAL_PHASES = new Set([
  "completedSuccess",
  "completedInterrupted",
  "error",
  "failed",
]);

type RowLike = {
  kind?: string;
  status?: string;
  state?: string;
};

type WorkLike = { status?: string; kind?: string } | null | undefined;

type SnapshotLike = {
  control?: { canStop?: boolean; phase?: string } | null;
  rows?: { window?: readonly RowLike[] | null } | null;
  backgroundWorks?: readonly WorkLike[] | null;
} | null;

/** 工作流 / 协作节点：有独立图标与进度卡，不绑对话右下角停止钮。 */
const BACKGROUND_WORK_KINDS_EXCLUDED_FROM_STOP = new Set([
  "workflow",
  "collab_subtask",
]);

export function isTerminalControlPhase(phase?: string | null): boolean {
  return TERMINAL_PHASES.has(String(phase || "").trim());
}

/**
 * 统计会拖住「对话停止 / 工作中」的后台活。
 * 刻意不含 workflow：对话 turn 结束即该停；工作流继续跑只亮 SessionChildWorkIcons。
 */
export function countRunningBackgroundWorks(
  works: readonly WorkLike[] | null | undefined,
): number {
  if (!works || works.length === 0) return 0;
  let n = 0;
  for (const w of works) {
    if (String(w?.status || "") !== "running") continue;
    const kind = String(w?.kind || "").trim();
    if (BACKGROUND_WORK_KINDS_EXCLUDED_FROM_STOP.has(kind)) continue;
    n += 1;
  }
  return n;
}

export function rowIsLiveToolCall(
  row: RowLike | null | undefined,
  opts: { allowEmptyStatus?: boolean } = {},
): boolean {
  if (!row || row.kind !== "toolCall") return false;
  const status = String(row.status || row.state || "").trim();
  if (!status) {
    // 空 status 只在尾窗调用方允许时视为活（防历史空字段把 busy 钉死）。
    return opts.allowEmptyStatus === true;
  }
  if (TERMINAL_TOOL_STATUSES.has(status)) return false;
  return LIVE_TOOL_STATUSES.has(status) || status === "in_progress";
}

export function rowIsPendingApprovalTool(row: RowLike | null | undefined): boolean {
  if (!row || row.kind !== "toolCall") return false;
  return String(row.status || row.state || "").trim() === "pendingApproval";
}

export function rowIsStreamingContent(row: RowLike | null | undefined): boolean {
  if (!row) return false;
  if (!STREAMING_ROW_KINDS.has(String(row.kind || ""))) return false;
  return String(row.state || "").trim() === "streaming";
}

export function hasLiveToolCallRows(
  rows: readonly RowLike[] | null | undefined,
): boolean {
  if (!rows || rows.length === 0) return false;
  for (const row of rows) {
    if (rowIsLiveToolCall(row)) return true;
  }
  return false;
}

export function hasStreamingContentRows(
  rows: readonly RowLike[] | null | undefined,
): boolean {
  if (!rows || rows.length === 0) return false;
  for (const row of rows) {
    if (rowIsStreamingContent(row)) return true;
  }
  return false;
}

export function hasPendingApprovalInRowTail(
  rows: readonly RowLike[] | null | undefined,
  tail = 24,
): boolean {
  if (!rows || rows.length === 0) return false;
  const start = Math.max(0, rows.length - Math.max(1, tail));
  for (let i = start; i < rows.length; i++) {
    if (rowIsPendingApprovalTool(rows[i])) return true;
  }
  return false;
}

/** 只扫窗口尾部，避免整窗 O(n) 每帧；活工具几乎都在尾部。 */
export function hasLiveActivityInRowTail(
  rows: readonly RowLike[] | null | undefined,
  tail = 24,
  opts: { allowEmptyStatus?: boolean } = {},
): boolean {
  if (!rows || rows.length === 0) return false;
  const allowEmpty = opts.allowEmptyStatus !== false;
  const start = Math.max(0, rows.length - Math.max(1, tail));
  const emptyStatusFrom = Math.max(start, rows.length - 6);
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (rowIsStreamingContent(row)) return true;
    if (
      rowIsLiveToolCall(row, {
        allowEmptyStatus: allowEmpty && i >= emptyStatusFrom,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function resolveLiveExecutionBusy(opts: {
  canStop?: boolean | null;
  phase?: string | null;
  rows?: readonly RowLike[] | null;
  runningBackgroundWorkCount?: number;
  /**
   * 宿主侧栏执行态。false + phase 已终态：忽略陈旧 running 工具卡
   * （多会话切回后侧栏已停、画布仍转的根因）。
   * false 时也不再单独信滞后 canStop（用户点停后投影常晚一拍，否则停止钮空转）。
   */
  hostExecuting?: boolean | null;
}): boolean {
  const hostIdle = opts.hostExecuting === false;
  // 宿主已 idle 时不信滞后 canStop；sse_final 早关仍靠 phase/工具行保活。
  if (opts.canStop && !hostIdle) return true;
  if ((opts.runningBackgroundWorkCount || 0) > 0) return true;
  if (String(opts.phase || "") === "running") return true;

  const terminal = isTerminalControlPhase(opts.phase);

  // 侧栏已 idle 且控制相终态：只保留 streaming / 待审批；勿钉陈旧 running。
  if (hostIdle && terminal) {
    if (hasStreamingContentRows(opts.rows)) return true;
    if (hasPendingApprovalInRowTail(opts.rows)) return true;
    return false;
  }

  if (
    hasLiveActivityInRowTail(opts.rows, 24, {
      // 终态下空 status 一律不活，防历史空字段钉死。
      allowEmptyStatus: !terminal,
    })
  ) {
    return true;
  }
  return false;
}

export function resolveLiveExecutionBusyFromSnapshot(
  snapshot: SnapshotLike,
  runningBackgroundWorkCount?: number,
  opts?: { hostExecuting?: boolean | null },
): boolean {
  const bg =
    runningBackgroundWorkCount == null
      ? countRunningBackgroundWorks(snapshot?.backgroundWorks)
      : runningBackgroundWorkCount;
  if (!snapshot) return bg > 0;
  return resolveLiveExecutionBusy({
    canStop: snapshot.control?.canStop,
    phase: snapshot.control?.phase,
    rows: snapshot.rows?.window,
    runningBackgroundWorkCount: bg,
    hostExecuting: opts?.hostExecuting,
  });
}
