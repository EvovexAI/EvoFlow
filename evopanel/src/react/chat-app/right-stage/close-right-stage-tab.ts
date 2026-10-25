/**
 * Close one right-stage tab by key, with kind-specific cleanup.
 * Extracted from ChatApp.tsx (P25).
 */
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind } from '../../../lib/right-stage/right-stage-types.js'

export type CloseRightStageTabCtx = {
  dismissedRightStageKindsRef: { current: Set<string> }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  userClosedInfoRailRef: { current: boolean }
  /** 任务级 dismiss（`{sessionKey}:{taskId}`）：关工作流签时抑制该任务自动重开。 */
  collabExecDismissedKeysRef?: { current: Set<string> }
  closeWorkspacePanel: () => void
  closeCollabExecPanel: () => void
  closeKnowledgeMapPanel: () => void
  closeBrowserStage: (id: string) => void
  closeSummaryStage: () => void
  closeRightStageTab: (key: string) => void
  setInfoRailOpen: (open: boolean) => void
}

export function closeRightStageTabByKey(ctx: CloseRightStageTabCtx, key: string): void {
  const tab = rightStageStore.getSnapshot().tabs.find((t) => `${normalizeRightStageKind(t.kind)}:${t.id}` === key)
  const kind = normalizeRightStageKind(tab?.kind || key.split(':')[0] || '')
  if (kind) ctx.dismissedRightStageKindsRef.current.add(kind)
  if (kind === 'workspace-browse' || kind === 'write') {
    ctx.closeWorkspacePanel()
    return
  }
  if (kind === 'collab-workflow') {
    // 关一个工作流签只关该签：dismiss 该签自己的任务（复用 closeCollabExecPanel 的
    // 防自动重开语义）后单签关闭。不再走 closeCollabExecPanel → hideRightStageIfKind
    // 整 kind 清场——多工作流并开时那会把其它工作流签一起关掉。
    const data = (tab?.data ?? {}) as { mainTaskId?: unknown }
    const taskId = String(data.mainTaskId || '').trim()
    const sk = String(tab?.sessionKey || '').trim()
    if (ctx.collabExecDismissedKeysRef && sk && taskId) {
      ctx.collabExecDismissedKeysRef.current.add(`${sk}:${taskId}`)
    }
    if (ctx.rightStageUserPinnedRef.current === 'collab-workflow') {
      ctx.rightStageUserPinnedRef.current = null
    }
    ctx.closeRightStageTab(key)
    return
  }
  if (kind === 'mind-map') {
    ctx.closeKnowledgeMapPanel()
    return
  }
  if (kind === 'browser') {
    ctx.closeBrowserStage(tab?.id || 'primary')
    return
  }
  if (kind === 'summary') {
    ctx.userClosedInfoRailRef.current = true
    ctx.setInfoRailOpen(false)
    ctx.closeSummaryStage()
    return
  }
  ctx.closeRightStageTab(key)
  if (ctx.rightStageUserPinnedRef.current === kind) {
    ctx.rightStageUserPinnedRef.current = null
  }
}
