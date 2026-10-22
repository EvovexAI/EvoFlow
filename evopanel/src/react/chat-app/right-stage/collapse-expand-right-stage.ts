/**
 * Collapse / expand right stage shell (tabs retained on collapse).
 * Extracted from ChatApp.tsx (P28).
 */
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../../../lib/chat-overlay-defer.js'
import {
  saveChatSummaryDisplayMode,
  type ChatSummaryDisplayMode,
} from '../../lib/chat-summary-panel-prefs.js'

export type CollapseRightStageCtx = {
  rightStageUserPinnedRef: { current: RightStageKind | null }
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  collapseRightStage: () => void
  syncShellAsideForWorkspacePanel: (open: boolean) => void
}

export type ExpandRightStageCtx = {
  chatPanelMode: ChatSummaryDisplayMode
  scheduleBumpRef: { current: ((opts?: { immediate?: boolean }) => void) | null }
  expandRightStage: () => void
  setChatPanelMode: (mode: ChatSummaryDisplayMode) => void
  setInfoRailOpen: (open: boolean) => void
}

export function collapseRightStageShell(ctx: CollapseRightStageCtx): void {
  ctx.rightStageUserPinnedRef.current = null
  ctx.collapseRightStage()
  setChatOverlayDefer('workspace', false)
  setChatOverlayDefer('workflow', false)
  setChatOverlayDefer('knowledge-map', false)
  ctx.syncShellAsideForWorkspacePanel(false)
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}

export function expandRightStageShell(ctx: ExpandRightStageCtx): void {
  // 专用侧栏与状态卡片互斥：开侧栏时把状态收成气泡偏好，避免关侧栏后又立刻弹回卡片。
  if (ctx.chatPanelMode === 'panel') {
    ctx.setChatPanelMode('capsule')
    saveChatSummaryDisplayMode('capsule')
  }
  ctx.expandRightStage()
  ctx.setInfoRailOpen(false)
  if (!isChatOverlayDeferActive()) {
    ctx.scheduleBumpRef.current?.({ immediate: true })
  }
}
