// @ts-nocheck — mechanical P132 extract.
/**
 * Publish turn-run artifacts into UI / info rail (respects auto-preview setting).
 * Extracted from ChatApp.tsx (P132).
 */
export type PublishArtifactsCtx = Record<string, any>

export function publishArtifacts(
  ctx: PublishArtifactsCtx,
  opts?: { focusId?: string; hint?: string; force?: boolean },
): void {
  const items = ctx.turnRunArtifactsRef.current
  if (!items.length) return
  ctx.setTurnArtifacts([...items])
  const autoPreview = ctx.isAutoWorkPreviewEnabled(ctx.writeStreamModeRef.current)
  if (!autoPreview && !opts?.force) return
  if (ctx.rightStageHintTimerRef.current) {
    clearTimeout(ctx.rightStageHintTimerRef.current)
    ctx.rightStageHintTimerRef.current = 0
  }
  ctx.hideRightStageIfKind('artifacts')
  ctx.setInfoRailOpen(true)
  ctx.setInfoRailTab('artifacts')
  const focus = String(opts?.focusId || items[items.length - 1]?.id || '').trim()
  if (focus) ctx.setArtifactFocusId(focus)
  if (opts?.hint) ctx.toast(opts.hint, 'info')
}
