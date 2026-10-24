/**
 * Toggle browser right-stage tab for the current session.
 * Extracted from ChatApp.tsx (P48).
 */
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { filterRightStageTabsForSession } from '../../../lib/right-stage/right-stage-session-visibility.js'
import { isChatOverlayDeferActive } from '../../../lib/chat-overlay-defer.js'

export type ToggleBrowserStageCtx = {
  selectedSessionKey: string
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  closeBrowserStage: (id: string) => void
  setBrowserPanelThreadId: (tid: string) => void
  getSessionThreadId: (sessionKey: string) => string | null | undefined
  ensureBrowserStage: (opts: { sessionKey?: string }) => void
}

export function toggleBrowserStage(ctx: ToggleBrowserStageCtx): void {
  const snap = rightStageStore.getSnapshot()
  const existing = filterRightStageTabsForSession(snap.tabs, ctx.selectedSessionKey).find(
    (t) => normalizeRightStageKind(t.kind) === 'browser',
  )
  if (existing) {
    const key = `${normalizeRightStageKind(existing.kind)}:${existing.id}`
    if (snap.activeKey === key) {
      ctx.closeBrowserStage(existing.id)
      return
    }
    rightStageStore.activateTab(key)
    return
  }
  const manualTid = String(ctx.getSessionThreadId(ctx.selectedSessionKey || '') || '').trim()
  if (manualTid) ctx.setBrowserPanelThreadId(manualTid)
  ctx.ensureBrowserStage({ sessionKey: ctx.selectedSessionKey || undefined })
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}
