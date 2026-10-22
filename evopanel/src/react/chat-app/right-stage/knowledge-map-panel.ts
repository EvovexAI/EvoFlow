/**
 * Open / close mind-map (knowledge map) right-stage panel.
 * Extracted from ChatApp.tsx (P32).
 */
import { flushSync } from 'react-dom'
import type { Dispatch, SetStateAction } from 'react'
import { hideRightStageIfKind } from '../../../lib/right-stage/right-stage-store.js'
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../../../lib/chat-overlay-defer.js'

export type OpenKnowledgeMapPanelCtx = {
  knowledgeMapEnabled: boolean
  cancelPendingStreamUiBumpsRef: { current: () => void }
  rightStageUserPinnedRef: { current: RightStageKind | null }
  setKnowledgeMapRefreshKey: Dispatch<SetStateAction<number>>
  setKnowledgeMapPanelOpen: (open: boolean) => void
}

export type CloseKnowledgeMapPanelCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
}

export function openKnowledgeMapPanel(ctx: OpenKnowledgeMapPanelCtx): void {
  if (!ctx.knowledgeMapEnabled) return
  ctx.cancelPendingStreamUiBumpsRef.current()
  setChatOverlayDefer('knowledge-map', true)
  flushSync(() => {
    ctx.setKnowledgeMapRefreshKey((k) => k + 1)
    ctx.rightStageUserPinnedRef.current = 'mind-map'
    ctx.setKnowledgeMapPanelOpen(true)
  })
}

export function closeKnowledgeMapPanel(ctx: CloseKnowledgeMapPanelCtx): void {
  setChatOverlayDefer('knowledge-map', false)
  ctx.rightStageUserPinnedRef.current = null
  hideRightStageIfKind('mind-map')
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}
