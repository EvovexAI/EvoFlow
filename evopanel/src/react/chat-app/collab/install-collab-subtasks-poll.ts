// @ts-nocheck — mechanical P99 extract.
/**
 * While collab exec is active, bump subtasks API refresh. Extracted (P99).
 *
 * 轮询节奏（不影响性能）：
 * - 有子任务在跑 → 2s（用户要看到「此刻在跑什么工具/正文」，要跟得上）
 * - 只有主任务在跑 → 3s
 * - 标签页隐藏 → 跳过 tick（浏览器已经在省电了）
 * - 全终态 → 停止轮询
 */
export type InstallCollabSubtasksPollCtx = Record<string, any>

const ACTIVE_SUBTASK_STATUSES = new Set([
  'in_progress',
  'running',
  'executing',
  'active',
  'pending',
  'queued',
])

export function runCollabSubtasksPollEffect(
  ctx: InstallCollabSubtasksPollCtx,
): void | (() => void) {
  const {
    bumpSubtasksApiRefresh,
    collabSubtasksFetchEnabled,
    isActiveExecTaskStatus,
    selectedTurnBusy,
    sharedCollabMainTaskStatus,
    sharedCollabSubtasks,
    threadPanelState,
  } = ctx
  if (!collabSubtasksFetchEnabled) return
  const phaseLc = String(threadPanelState.collabPhase || '').trim().toLowerCase()
  const isRunning =
    isActiveExecTaskStatus(sharedCollabMainTaskStatus) ||
    phaseLc === 'executing' ||
    phaseLc === 'verifying' ||
    phaseLc === 'reflecting' ||
    selectedTurnBusy
  // 主任务不在跑，但有子任务在跑 → 也要轮询。
  // 否则「主任务已 planned/awaiting、子任务在跑」时节点会停止刷新（用户看到空白卡片）。
  const subs = Array.isArray(sharedCollabSubtasks) ? sharedCollabSubtasks : []
  const hasRunningSubtask = subs.some((s) =>
    ACTIVE_SUBTASK_STATUSES.has(String(s?.status || '').trim().toLowerCase()),
  )
  if (!isRunning && !hasRunningSubtask) return
  const tick = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    bumpSubtasksApiRefresh()
  }
  // 有子任务在跑时更密一点，让节点实时行跟得上。
  const intervalMs = hasRunningSubtask ? 2000 : 3000
  const interval = window.setInterval(tick, intervalMs)
  return () => window.clearInterval(interval)
}
