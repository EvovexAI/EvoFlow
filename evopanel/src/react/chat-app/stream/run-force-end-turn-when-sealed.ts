// @ts-nocheck — mechanical P121 extract.
/**
 * While selected turn is busy: if the last sealed assistant already has
 * duration/token and stream is empty / stale, force-end sending state.
 * Extracted from ChatApp.tsx (P121).
 */
export type RunForceEndTurnWhenSealedCtx = Record<string, any>

export function runForceEndTurnWhenSealedEffect(ctx: RunForceEndTurnWhenSealedCtx): void {
  if (!ctx.selectedTurnBusy) return
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return
  const rt = ctx.getSessionRuntime(sk)
  if (ctx.streamRefHasVisibleContent(ctx.streamRef.current)) return
  // 找最近一条已封口的 assistant（其后可能已有 ↑「待处理」用户行）
  let sealedAssistant: any = null
  let pendingInjectAfterSeal = false
  for (let i = ctx.renderRows.length - 1; i >= 0; i--) {
    const r = ctx.renderRows[i]
    if (r?.role === 'assistant') {
      sealedAssistant = r
      break
    }
    if (r?.role === 'user' && r.pendingInject) {
      pendingInjectAfterSeal = true
      continue
    }
    break
  }
  if (
    !sealedAssistant ||
    !(sealedAssistant.durationStr || sealedAssistant.tokenStr) ||
    sealedAssistant.incompleteStream
  ) {
    return
  }
  const lastEventAt = Number(rt.lastEventAt || 0)
  const eventStale = !lastEventAt || Date.now() - lastEventAt > 3000
  // 有 ↑ 待处理 / sealing / 事件已停：强制 idle，避免 DB 残留 running 卡住 drain
  const force = pendingInjectAfterSeal || rt.turnPhase === 'sealing' || eventStale
  ctx.maybeEndTurnSendingState(sk, rt, false, force ? { force: true } : undefined)
}
