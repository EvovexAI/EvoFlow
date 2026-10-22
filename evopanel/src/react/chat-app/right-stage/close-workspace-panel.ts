/**
 * Close workspace-browse / write right-stage surfaces.
 * Extracted from ChatApp.tsx (P30).
 */
import { hideRightStageIfKind, rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../../../lib/chat-overlay-defer.js'

export type CloseWorkspacePanelCtx = {
  dismissedRightStageKindsRef: { current: Set<string> }
  writeStreamDismissedRef: { current: boolean }
  lastStreamWritePathRef: { current: string | null }
  lastWriteStreamLenRef: { current: number }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  setStreamingWritePreview: (v: null) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  syncShellAsideForWorkspacePanel: (open: boolean) => void
}

export function closeWorkspacePanel(ctx: CloseWorkspacePanelCtx): void {
  const kind = normalizeRightStageKind(rightStageStore.getSnapshot().surface?.kind || '')
  if (kind === 'write' || kind === 'workspace-browse') {
    ctx.dismissedRightStageKindsRef.current.add(kind)
    if (kind === 'write') ctx.writeStreamDismissedRef.current = true
  }
  ctx.setStreamingWritePreview(null)
  ctx.lastStreamWritePathRef.current = null
  ctx.lastWriteStreamLenRef.current = 0
  setChatOverlayDefer('workspace', false)
  ctx.rightStageUserPinnedRef.current = null
  hideRightStageIfKind('workspace-browse', 'write')
  ctx.setWorkspaceTreePinned(false)
  ctx.syncShellAsideForWorkspacePanel(false)
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}
