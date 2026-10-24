// @ts-nocheck — mechanical P132 extract.
/**
 * Publish turn-run artifacts into UI / info rail (respects auto-preview setting).
 * Extracted from ChatApp.tsx (P132).
 *
 * ``force``：显式 panel_set(kind=artifacts) 必须打开状态卡，不跟「自动打开工作预览」走。
 */
export type PublishArtifactsCtx = Record<string, any>

export function publishArtifacts(
  ctx: PublishArtifactsCtx,
  opts?: { focusId?: string; hint?: string; force?: boolean },
): void {
  const items = ctx.turnRunArtifactsRef.current
  if (!items.length) return
  ctx.setTurnArtifacts([...items])
  // V4 对话正文不进旧 rows 时，也要让状态卡有资格显示
  if (typeof ctx.setSessionHadContent === 'function') {
    ctx.setSessionHadContent(true)
  }
  const autoPreview = ctx.isAutoWorkPreviewEnabled(ctx.writeStreamModeRef.current)
  if (!autoPreview && !opts?.force) return
  if (ctx.rightStageHintTimerRef.current) {
    clearTimeout(ctx.rightStageHintTimerRef.current)
    ctx.rightStageHintTimerRef.current = 0
  }
  ctx.hideRightStageIfKind('artifacts')
  // 与平台通知同路径：展开对话右上角状态卡并切到「产物」
  if (typeof ctx.setChatPanelDisplayMode === 'function') {
    ctx.setChatPanelDisplayMode('panel')
  }
  ctx.setInfoRailOpen(true)
  ctx.setInfoRailTab('artifacts')
  const focus = String(opts?.focusId || items[items.length - 1]?.id || '').trim()
  if (focus) ctx.setArtifactFocusId(focus)
  if (opts?.hint) ctx.toast(opts.hint, 'info')
}
