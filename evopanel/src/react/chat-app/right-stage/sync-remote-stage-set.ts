/**
 * Apply STAGE_SET_APPLIED remote payload to local right-stage / artifacts state.
 * Extracted from ChatApp.tsx (P19).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { hideRightStageIfKind } from '../../../lib/right-stage/right-stage-store.js'
import type { StageSetPayload } from '../../../lib/right-stage/right-stage-agui.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import {
  clearAllRightStageOverlayDefer,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import {
  mergeChatArtifacts,
  normalizeChatArtifacts,
  type ChatArtifact,
} from '../../lib/chat-artifact.js'

export type SyncRemoteStageSetCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  cancelPendingStreamUiBumpsRef: { current: () => void }
  lastStreamWritePathRef: { current: string | null }
  turnRunArtifactsRef: MutableRefObject<ChatArtifact[]>
  setSessionArtifactsRef: MutableRefObject<
    Dispatch<SetStateAction<ChatArtifact[]>>
  >
  publishArtifactsRef: MutableRefObject<
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => void
  >
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  setStreamingWritePreview: (v: null) => void
  setWorkspaceTreePinned: (pinned: boolean) => void
  setKnowledgeMapRefreshKey: Dispatch<SetStateAction<number>>
}

export function syncRemoteStageSet(ctx: SyncRemoteStageSetCtx, detail: StageSetPayload): void {
  const kind = String(detail.surface?.kind || '').trim()
  if (detail.action === 'hide' || !kind) {
    ctx.rightStageUserPinnedRef.current = null
    clearAllRightStageOverlayDefer()
    ctx.syncShellAsideForWorkspacePanel(false)
    resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
    return
  }
  // 产物改由侧栏 Info Rail 呈报，不走 Right Stage
  if (kind === 'artifacts') {
    hideRightStageIfKind('artifacts')
    const data = (detail.surface?.data || {}) as Record<string, unknown>
    const incoming = normalizeChatArtifacts(data.items)
    if (incoming.length) {
      ctx.turnRunArtifactsRef.current = mergeChatArtifacts(ctx.turnRunArtifactsRef.current, incoming)
      ctx.setSessionArtifactsRef.current((prev) => mergeChatArtifacts(prev, incoming))
      ctx.publishArtifactsRef.current({
        focusId: String(data.focusId || incoming[incoming.length - 1]?.id || ''),
      })
    }
    return
  }
  ctx.cancelPendingStreamUiBumpsRef.current()
  ctx.rightStageUserPinnedRef.current = kind as RightStageKind
  clearAllRightStageOverlayDefer()
  setRightStageOverlayDefer('workspace', kind === 'workspace-browse' || kind === 'write')
  setRightStageOverlayDefer('knowledge-map', kind === 'mind-map')
  if (kind !== 'write') {
    ctx.setStreamingWritePreview(null)
    ctx.lastStreamWritePathRef.current = null
  }
  ctx.setWorkspaceTreePinned(kind === 'workspace-browse')
  if (kind === 'mind-map') {
    ctx.setKnowledgeMapRefreshKey((k) => k + 1)
  }
  if (kind === 'news-dashboard' || kind === 'web-embed') {
    ctx.syncShellAsideForWorkspacePanel(true)
  }
  ctx.scheduleBumpRef.current?.({ immediate: true })
}
