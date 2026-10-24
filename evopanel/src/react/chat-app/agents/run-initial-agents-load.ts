// @ts-nocheck — mechanical P124 extract.
/**
 * Mount-once: load agent picker rows into ChatApp state.
 * Extracted from ChatApp.tsx (P124).
 */
export type RunInitialAgentsLoadCtx = Record<string, any>

export function runInitialAgentsLoadEffect(ctx: RunInitialAgentsLoadCtx): () => void {
  let cancelled = false
  void (async () => {
    try {
      const api = await ctx.getApi()
      const [agentResult] = await Promise.all([api.listAgents()])
      if (cancelled) return
      const list = Array.isArray(agentResult) ? agentResult : agentResult?.agents || []
      ctx.setAgents(ctx.mapAgentPickerRows(list))
      ctx.setAgentsDisplayCache(list)
    } catch {
      if (!cancelled) {
        ctx.setAgents([])
      }
    }
  })()
  return () => {
    cancelled = true
  }
}
