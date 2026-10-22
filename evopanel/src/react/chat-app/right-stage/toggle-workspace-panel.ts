/**
 * Toggle workspace-browse / write tab in the right stage.
 * Extracted from ChatApp.tsx (P27).
 */
import { flushSync } from 'react-dom'
import { hideRightStageIfKind, rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind, type RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../../../lib/chat-overlay-defer.js'

export type ToggleWorkspacePanelCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  streamingWritePreviewRef: { current: { streaming?: boolean } | null }
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  setWorkspacePanelOpen: (open: boolean) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setStreamingWritePreview: (v: null) => void
}

export function toggleWorkspacePanel(ctx: ToggleWorkspacePanelCtx): void {
  const snap = rightStageStore.getSnapshot()
  const existing = snap.tabs.find((t) => {
    const k = normalizeRightStageKind(t.kind)
    return k === 'workspace-browse' || k === 'write'
  })
  if (existing) {
    const key = `${normalizeRightStageKind(existing.kind)}:${existing.id}`
    if (snap.activeKey === key) {
      setChatOverlayDefer('workspace', false)
      flushSync(() => {
        ctx.rightStageUserPinnedRef.current = null
        hideRightStageIfKind('workspace-browse', 'write')
        ctx.setStreamingWritePreview(null)
        ctx.lastStreamWritePathRef.current = null
        ctx.setWorkspaceTreePinned(false)
        ctx.syncShellAsideForWorkspacePanel(false)
      })
      if (!isChatOverlayDeferActive()) {
        ctx.scheduleBumpRef.current?.({ immediate: true })
      }
      return
    }
    rightStageStore.activateTab(key)
    return
  }
  ctx.cancelPendingStreamUiBumpsRef.current()
  setChatOverlayDefer('workspace', true)
  flushSync(() => {
    ctx.syncShellAsideForWorkspacePanel(true)
    ctx.rightStageUserPinnedRef.current = 'workspace-browse'
    ctx.setWorkspacePanelOpen(true)
    ctx.setWorkspaceTreePinned(true)
    if (!ctx.streamingWritePreviewRef.current?.streaming) {
      ctx.setStreamingWritePreview(null)
      ctx.lastStreamWritePathRef.current = null
    }
  })
}
