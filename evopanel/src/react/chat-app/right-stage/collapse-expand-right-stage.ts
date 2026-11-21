/**
 * Collapse / expand right stage shell (tabs retained on collapse).
 * Extracted from ChatApp.tsx (P28).
 */
import type { RightStageKind } from '../../../lib/right-stage/right-stage-types.js'
import {
  flushRightStageSessionPersistence,
  getCurrentRightStageSessionKey,
  saveRightStageSessionMemory,
} from '../../../lib/right-stage/right-stage-session-memory.js'
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
  // store.collapse 会钉 userCollapsed，挡住随后的同签 show/autoOpen 强行撑开。
  ctx.collapseRightStage()
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：收起之后**立刻**把当前会话记忆冻结进 sessionStorage。
  // 为什么（本轮真机实测抓到的真缺陷）：``saveRightStageSessionMemory`` 此前只在
  //   「切会话」时被调用，收起这条路径完全不写。于是：
  //     用户点收起 → 内存里 collapsed=true、但 sessionStorage 里还是收起前的旧快照
  //     （标签 N 个、collapsed=false）→ 任何一次 webview reload(pagehide 只 flush
  //     已排队的旧内容) 都会把旧快照恢复回来 → 标签复活、右栏自己弹开。
  //   实测证据 2026-11-21 08:25:52 收起后 tabs=0/collapsed=true(rev35)，
  //   08:26:29 前端 reload，08:26:34 上报变回 tabs=4/collapsed=false 且 **rev 重置为 1**
  //   —— rev 归 1 是「store 被重建并从旧记忆恢复」的指纹，不是用户操作。
  // 判据：收起/展开这两个手势都必须把最新意图落进会话记忆，不能只改 live store。
  saveRightStageSessionMemory(getCurrentRightStageSessionKey())
  flushRightStageSessionPersistence()
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
