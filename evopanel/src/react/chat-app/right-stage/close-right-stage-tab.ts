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
    ctx.closeCollabExecPanel()
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
