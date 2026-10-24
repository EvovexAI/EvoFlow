/**
 * Toggle/open a built-in user stage extension kind in the right stage.
 * Extracted from ChatApp.tsx (P26).
 */
import { flushSync } from 'react-dom'
import { hideRightStageIfKind } from '../../../lib/right-stage/right-stage-store.js'
import {
  isUserStageExtensionKind,
  titleForUserStageExtension,
  type UserStageExtensionKind,
} from '../../../lib/right-stage/right-stage-extensions.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import {
  RIGHT_STAGE_OVERLAY_DEFER_KEYS,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'

export type OpenStageExtensionCtx = {
  rightStageSurfaceKind: string | null | undefined
  rightStageOpen: boolean
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  writeStreamDismissedRef: { current: boolean }
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  showKind: (
    kind: RightStageKind,
    opts?: { title?: string; data?: Record<string, unknown> },
  ) => void
  setWorkspacePanelOpen: (open: boolean) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setCollabExecPanelOpen: (open: boolean) => void
  setKnowledgeMapPanelOpen: (open: boolean) => void
}

export function openStageExtension(
  ctx: OpenStageExtensionCtx,
  kind: UserStageExtensionKind,
): void {
  if (ctx.rightStageSurfaceKind === kind && ctx.rightStageOpen) {
    ctx.rightStageUserPinnedRef.current = null
    hideRightStageIfKind(kind)
    if (isUserStageExtensionKind(kind)) {
      ctx.syncShellAsideForWorkspacePanel(false)
    }
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }
  ctx.cancelPendingStreamUiBumpsRef.current()
  // 扩展面板本身不占 overlay defer；先清掉其它侧栏 defer，再同帧切布局。
  setRightStageOverlayDefer(RIGHT_STAGE_OVERLAY_DEFER_KEYS, false)
  ctx.syncShellAsideForWorkspacePanel(true)
  flushSync(() => {
    ctx.setWorkspacePanelOpen(false)
    ctx.setWorkspaceTreePinned(false)
    ctx.setStreamingWritePreview(null)
    ctx.lastStreamWritePathRef.current = null
    ctx.setCollabExecPanelOpen(false)
    ctx.setKnowledgeMapPanelOpen(false)
    ctx.writeStreamDismissedRef.current = false
    ctx.rightStageUserPinnedRef.current = kind
    const extensionData = kind === 'web-embed' ? { url: '', editable: true } : undefined
    ctx.showKind(kind, {
      title: titleForUserStageExtension(kind),
      data: extensionData,
    })
  })
}
