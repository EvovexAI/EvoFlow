/**
 * Collapse / expand right stage shell (tabs retained on collapse).
 * Extracted from ChatApp.tsx (P28).
 */
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import {
  clearAllRightStageOverlayDefer,
  resumeStreamBumpIfIdle,
} from '../../../lib/right-stage/right-stage-overlay-commit.js'
import {
  saveChatSummaryDisplayMode,
  type ChatSummaryDisplayMode,
} from '../../lib/chat-summary-panel-prefs.js'
import { afterXwVoiceExitSettle } from '../../../lib/xw-voice-embed-settle.js'
import { exitXwVoiceMode, isXwVoiceMode } from '../../../lib/xw-voice-mode.js'

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

function finishCollapseRightStage(ctx: CollapseRightStageCtx): void {
  ctx.collapseRightStage()
  clearAllRightStageOverlayDefer()
  ctx.syncShellAsideForWorkspacePanel(false)
  resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
}

export function collapseRightStageShell(ctx: CollapseRightStageCtx): void {
  ctx.rightStageUserPinnedRef.current = null
  // 语音全屏下只 collapse 会留下「左半语音域 + 聊天 chrome 仍被 CSS 藏掉」，
  // 且收起钮消失后难以再开。收起前必须先退出语音全屏（关面板 ≡ 退出整套语音）。
  if (isXwVoiceMode()) {
    exitXwVoiceMode()
    // 先让 BrowserPanel 按退出后的窄槽位 set_bounds，再 park；同拍 collapse 会把
    // HWND 冻在语音态大矩形（打开图片/再展开时错位 Δ≈-600）。
    afterXwVoiceExitSettle({ then: () => finishCollapseRightStage(ctx) })
    return
  }
  finishCollapseRightStage(ctx)
}

export function expandRightStageShell(ctx: ExpandRightStageCtx): void {
  // 专用侧栏与状态卡片互斥：开侧栏时把状态收成气泡偏好，避免关侧栏后又立刻弹回卡片。
  if (ctx.chatPanelMode === 'panel') {
    ctx.setChatPanelMode('capsule')
    saveChatSummaryDisplayMode('capsule')
  }
  ctx.expandRightStage()
  ctx.setInfoRailOpen(false)
  resumeStreamBumpIfIdle(() => ctx.scheduleBumpRef.current?.({ immediate: true }))
}
