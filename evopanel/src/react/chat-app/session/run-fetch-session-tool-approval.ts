// @ts-nocheck — mechanical P129 extract.
/**
 * On selectedSessionKey change: fetch session tool-approval policy into wsClient cache.
 * Extracted from ChatApp.tsx (P129).
 */
export type RunFetchSessionToolApprovalCtx = Record<string, any>

export function runFetchSessionToolApprovalEffect(
  ctx: RunFetchSessionToolApprovalCtx,
): (() => void) | void {
  if (!ctx.selectedSessionKey) return
  let cancelled = false
  void (async () => {
    try {
      const result = await ctx.fetchSessionToolApprovalPolicy(ctx.selectedSessionKey)
      if (cancelled) return
      ctx.wsClient.applySessionToolApprovalPolicy(ctx.selectedSessionKey, result)
      ctx.setToolApprovalPolicyTick((n) => n + 1)
    } catch {
      /* Gateway 未就绪或会话尚未落库时沿用内存缓存 */
    }
  })()
  return () => {
    cancelled = true
  }
}
