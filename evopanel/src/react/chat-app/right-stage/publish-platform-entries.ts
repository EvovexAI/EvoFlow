// @ts-nocheck — mechanical P131 extract.
/**
 * Publish platform-run entries into turn/session state and open info rail.
 * Extracted from ChatApp.tsx (P131).
 */
export type PublishPlatformEntriesCtx = Record<string, any>

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
  // 浏览器面板由 agent 实时驱动（画布/点击/滚轮穿透）。平台条目改走状态面板
  // 呈报，不抢占 Right Stage——否则平台工具一发布条目，浏览器面板就被折叠。
  const browserStageLive = ctx.rightStageStore.getSnapshot().surface?.kind === 'browser'
  if (ctx.rightStageHintTimerRef.current) {
    clearTimeout(ctx.rightStageHintTimerRef.current)
    ctx.rightStageHintTimerRef.current = 0
  }
  if (!browserStageLive) {
    ctx.rightStageStore.hide()
  }
  // 强制展开右上角状态卡并切到「平台」（ChatSummaryPanel 靠 focus id 跳 tab）
  if (typeof ctx.setChatPanelDisplayMode === 'function') {
    ctx.setChatPanelDisplayMode('panel')
  }
  ctx.setInfoRailOpen(true)
  ctx.setInfoRailTab('platform')
  const focus = String(focusEntryId || ctx.latestPlatformRunEntryId(entries)).trim()
  if (focus) ctx.setPlatformFocusEntryId(focus)
}
