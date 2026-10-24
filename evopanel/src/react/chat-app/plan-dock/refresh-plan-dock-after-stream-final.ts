/**
 * After stream final: sync plan dock, optionally retry until planned.
 * Extracted from ChatApp.tsx (P39).
 */
import type { MutableRefObject } from 'react'

export type RefreshPlanDockAfterStreamFinalCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  planStreamLatchRef: MutableRefObject<{ planInput?: Record<string, unknown> } | null>
  planDockApiViewRef: MutableRefObject<{ show?: boolean } | null>
  syncPlanPanelFromApi: (opts: {
    source: string
    sessionKey?: string
    hintTaskId?: string
    bypassCache?: boolean
    fallback?: Record<string, unknown> | null
  }) => Promise<void>
}

export async function refreshPlanDockAfterStreamFinal(
  ctx: RefreshPlanDockAfterStreamFinalCtx,
  opts: {
    hintTaskId?: string
    sessionKey?: string
    retryUntilPlanned?: boolean
    fallback?: Record<string, unknown> | null
  },
): Promise<void> {
  const captureSk = String(opts.sessionKey || ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  const fallbackPlan = opts.fallback ?? ctx.planStreamLatchRef.current?.planInput ?? null
  const runSync = (source: string) =>
    ctx.syncPlanPanelFromApi({
      source,
      sessionKey: captureSk,
      hintTaskId: opts.hintTaskId,
      bypassCache: true,
      ...(fallbackPlan ? { fallback: fallbackPlan } : {}),
    })
  await runSync('stream_final')
  if (ctx.planDockApiViewRef.current?.show) {
    return
  }
  if (!opts.retryUntilPlanned) {
    return
  }
  for (const delayMs of [600, 1500]) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    if (String(ctx.sessionRef.current || '').trim() !== captureSk) return
    if (ctx.planDockApiViewRef.current?.show) return
    await runSync('stream_final_retry')
    if (ctx.planDockApiViewRef.current?.show) {
      return
    }
  }
}
