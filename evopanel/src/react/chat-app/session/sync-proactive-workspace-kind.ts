// @ts-nocheck — mechanical P112 extract.
/**
 * Sync workspace_kind into session context when entering a proactive employee session.
 * Extracted from ChatApp.tsx (P112).
 */
export type SyncProactiveWorkspaceKindCtx = Record<string, any>

export function runSyncProactiveWorkspaceKindEffect(
  ctx: SyncProactiveWorkspaceKindCtx,
): void {
  if (!ctx.isProactiveEmployeeSession) return
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return
  const parsed = ctx.parseProactiveSessionKey(sk)
  const patch: Record<string, unknown> = {
    source: 'proactive',
    proactive_agent_code: parsed.agentCode || null,
    employee_talk_mode: 'chat',
  }
  if (parsed.kind === 'task' && parsed.taskId) {
    patch.workspace_kind = 'task'
    patch.related_task_id = parsed.taskId
  } else if (parsed.kind === 'chat') {
    patch.workspace_kind = 'chat'
    patch.related_task_id = null
    // 与普通「新建对话」一致：未指定模式时默认 Agent（勿落到 ensure-thread 旧默认 ask）
    const curMode = String(ctx.wsClient.getSessionContext(sk)?.session_mode || '')
      .trim()
      .toLowerCase()
    if (!curMode) {
      patch.session_mode = 'agent'
      ctx.setSessionModeInMeta(sk, 'agent')
      ctx.setSessionMode('agent')
    }
  } else if (parsed.kind === 'duty') {
    patch.workspace_kind = 'duty'
    patch.related_task_id = null
  } else {
    patch.workspace_kind = 'legacy'
  }
  void ctx.wsClient.updateSessionContext(sk, patch).catch(() => {})
}
