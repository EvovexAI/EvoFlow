// @ts-nocheck — mechanical P128 extract.
/**
 * Window listeners for global/session tool-approval policy changes + full-access request.
 * Extracted from ChatApp.tsx (P128).
 */
export type InstallToolApprovalPolicyListenersCtx = Record<string, any>

export function runToolApprovalPolicyListenersEffect(
  ctx: InstallToolApprovalPolicyListenersCtx,
): () => void {
  const onGlobalChanged = () => {
    ctx.setToolApprovalPolicyTick((n) => n + 1)
    ctx.scheduleRefreshSessions(0)
  }
  const onSessionChanged = () => {
    ctx.setToolApprovalPolicyTick((n) => n + 1)
  }
  const onRequestSessionFullAccess = () => {
    void ctx.applyFullAccessToCurrentSessionRef.current({ quiet: true }).then(() => {
      ctx.toast('本会话已切换为完全访问', 'success')
    })
  }
  window.addEventListener(ctx.TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
  window.addEventListener(ctx.TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
  window.addEventListener(ctx.TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS, onRequestSessionFullAccess)
  return () => {
    window.removeEventListener(ctx.TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
    window.removeEventListener(ctx.TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
    window.removeEventListener(
      ctx.TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS,
      onRequestSessionFullAccess,
    )
  }
}
