// @ts-nocheck — mechanical P131 extract.
/**
 * Publish platform-run entries into turn/session state and open info rail.
 * Extracted from ChatApp.tsx (P131).
 */
import { isProgressStageKind } from '../../../lib/right-stage/open-progress-from-panel-set.js'
import { logRightStage } from '../../../lib/right-stage/panel-set-debug-log.js'

export type PublishPlatformEntriesCtx = Record<string, any>

/** 平台条目进 Info Rail 时，这些右栏不应被 hide 掉。 */
function shouldKeepRightStageOnPlatformPublish(kind: string | null | undefined): boolean {
  const k = String(kind || '').trim()
  if (!k) return false
  // 浏览器：agent 持续控制面（画布/点击）
  if (k === 'browser') return true
  // 工作流 / 节点 / 员工过程：常由平台 CTA（查看进度）刚打开，回合结束再 hide
  // 会表现为「对话一结束侧栏自己没了」。
  if (isProgressStageKind(k)) return true
  return false
}

export function publishPlatformEntries(
  ctx: PublishPlatformEntriesCtx,
  entries: any[],
  focusEntryId?: string,
): void {
  ctx.turnPlatformEntriesRef.current = entries
  ctx.setTurnPlatformEntries([...entries])
  ctx.setSessionPlatformEntries((prev) => {
    const map = new Map()
    for (const row of prev) map.set(row.id, row)
    for (const row of entries) map.set(row.id, row)
    return Array.from(map.values()).sort((a, b) => b.appliedAt - a.appliedAt)
  })
  if (!entries.length) return
  // 平台条目改走状态面板呈报；默认收掉无关右栏，但勿动浏览器 / 进度类面板。
  const snap = ctx.rightStageStore.getSnapshot()
  const activeKind = snap?.surface?.kind
  const keepActive = shouldKeepRightStageOnPlatformPublish(activeKind)
  // 进度 tab 可能在后台（例如刚切到别的签）：只要还开着就整栏保留。
  const hasProgressTab = Array.isArray(snap?.tabs)
    ? snap.tabs.some((t) => shouldKeepRightStageOnPlatformPublish(t?.kind))
    : false
  if (ctx.rightStageHintTimerRef.current) {
    clearTimeout(ctx.rightStageHintTimerRef.current)
    ctx.rightStageHintTimerRef.current = 0
  }
  // hideUnlessProgressOpen：即使竞态下 tabs 快照滞后，也不会拆掉已打开的工作流签
  logRightStage('publishPlatformEntries', {
    keepActive,
    hasProgressTab,
    activeKind,
    entryCount: entries.length,
    willHide: !keepActive && !hasProgressTab,
  }, { store: ctx.rightStageStore })
  if (!keepActive && !hasProgressTab) {
    if (typeof ctx.rightStageStore.hideUnlessProgressOpen === 'function') {
      ctx.rightStageStore.hideUnlessProgressOpen()
    } else {
      ctx.rightStageStore.hide()
    }
  } else if (typeof ctx.rightStageStore.expand === 'function') {
    // 工作流签还在但可能已被 setChatPanelDisplayMode 误 collapse：强制展开
    ctx.rightStageStore.expand()
  }
  // 强制展开右上角状态卡并切到「平台」（ChatSummaryPanel 靠 focus id 跳 tab）
  // 有进度签时 setChatPanelDisplayMode 不会再 collapse 侧栏（见该函数）。
  if (typeof ctx.setChatPanelDisplayMode === 'function') {
    ctx.setChatPanelDisplayMode('panel')
  }
  ctx.setInfoRailOpen(true)
  ctx.setInfoRailTab('platform')
  const focus = String(focusEntryId || ctx.latestPlatformRunEntryId(entries)).trim()
  if (focus) ctx.setPlatformFocusEntryId(focus)
  // 语音全屏：平台工具已有结果 → 才允许状态卡浮出（进语音时默认藏）
  try {
    void import('../../../lib/xw-voice-mode.js').then((m) => {
      if (m.isXwVoiceMode?.()) m.allowXwVoiceSummary?.()
    })
  } catch {
    /* ignore */
  }
}
