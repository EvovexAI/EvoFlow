/**
 * Close the active right-stage surface with kind-specific cleanup.
 * Extracted from ChatApp.tsx (P22).
 */
import { hideRightStageIfKind, rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { isUserStageExtensionKind } from '../../../lib/right-stage/right-stage-extensions.js'
import { isChatOverlayDeferActive } from '../../../lib/chat-overlay-defer.js'

export type CloseRightStageCtx = {
  dismissedRightStageKindsRef: { current: Set<string> }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  writeStreamDismissedRef: { current: boolean }
  lastWriteStreamLenRef: { current: number }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  closeWorkspacePanel: () => void
  closeKnowledgeMapPanel: () => void
  closeCollabExecPanel: () => void
  clearRightStageStream: (streamId: string) => void
  syncShellAsideForWorkspacePanel: (open: boolean) => void
}

export function closeRightStage(ctx: CloseRightStageCtx): void {
  const kind = normalizeRightStageKind(rightStageStore.getSnapshot().surface?.kind || '')
  if (kind) ctx.dismissedRightStageKindsRef.current.add(kind)
  if (kind === 'workspace-browse' || kind === 'write') {
    ctx.closeWorkspacePanel()
    return
  }
  if (kind === 'mind-map') {
    ctx.closeKnowledgeMapPanel()
    return
  }
  if (kind === 'collab-workflow') {
    ctx.closeCollabExecPanel()
    return
  }
  if (kind === 'write') {
    ctx.writeStreamDismissedRef.current = true
    ctx.lastWriteStreamLenRef.current = 0
    ctx.clearRightStageStream('write_file')
  }
  if (kind === 'artifacts') {
    hideRightStageIfKind('artifacts')
    ctx.rightStageUserPinnedRef.current = null
    if (!isChatOverlayDeferActive()) {
      ctx.scheduleBumpRef.current?.({ immediate: true })
    }
    return
  }
  if (isUserStageExtensionKind(kind)) {
    ctx.rightStageUserPinnedRef.current = null
    hideRightStageIfKind(kind)
    ctx.syncShellAsideForWorkspacePanel(false)
    if (!isChatOverlayDeferActive()) {
      ctx.scheduleBumpRef.current?.({ immediate: true })
    }
    return
  }
  ctx.rightStageUserPinnedRef.current = null
  rightStageStore.hide()
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}
