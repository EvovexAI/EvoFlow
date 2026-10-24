// @ts-nocheck — mechanical P140 extract.
/**
 * Whether tool-approval UI is disabled (effective grant-all for current session).
 * Extracted from ChatApp.tsx (P140).
 */
export type ResolveToolApprovalUiDisabledCtx = Record<string, any>

export function resolveToolApprovalUiDisabled(ctx: ResolveToolApprovalUiDisabledCtx): boolean {
  void ctx.toolApprovalPolicyTick
  const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  if (!sk) return ctx.isEffectiveToolApprovalGrantAll({})
  const sessionCtx = ctx.wsClient.getSessionContext(sk) || {}
  return ctx.isEffectiveToolApprovalGrantAll(sessionCtx)
}
