/**
 * Open / close collab-workflow right-stage panel.
 * Extracted from ChatApp.tsx (P31).
 */
import { hideRightStageIfKind } from '../../../lib/right-stage/right-stage-store.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import {
  commitRightStageClose,
  commitRightStageOpen,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'

export type OpenCollabExecPanelCtx = {
  cancelPendingStreamUiBumpsRef: { current: () => void }
  collabExecDismissedKeysRef: { current: Set<string> }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  collabExecPanelDismissKey: () => string
  bumpSubtasksApiRefresh: () => void
  setCollabExecPanelOpen: (open: boolean) => void
}

export type CloseCollabExecPanelCtx = {
  collabExecDismissedKeysRef: { current: Set<string> }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  collabExecPanelDismissKey: () => string
}

export function openCollabExecPanel(
  ctx: OpenCollabExecPanelCtx,
  opts?: { clearDismiss?: boolean },
): void {
  ctx.cancelPendingStreamUiBumpsRef.current()
  if (opts?.clearDismiss !== false) {
    const key = ctx.collabExecPanelDismissKey()
    if (key) ctx.collabExecDismissedKeysRef.current.delete(key)
  }
  commitRightStageOpen('workflow', () => {
    ctx.bumpSubtasksApiRefresh()
    ctx.rightStageUserPinnedRef.current = 'collab-workflow'
    ctx.setCollabExecPanelOpen(true)
  })
}

export function closeCollabExecPanel(ctx: CloseCollabExecPanelCtx): void {
  const key = ctx.collabExecPanelDismissKey()
  if (key) ctx.collabExecDismissedKeysRef.current.add(key)
  commitRightStageClose({
    clearDefer: 'workflow',
    flush: false,
    mutate: () => {
      ctx.rightStageUserPinnedRef.current = null
      hideRightStageIfKind('collab-workflow')
    },
    resumeBump: () => ctx.scheduleBumpRef.current?.({ immediate: true }),
  })
}
