// @ts-nocheck — mechanical P134 extract.
/**
 * Pure helpers for collab sidebar / workflow panel derived ids and visibility.
 * Extracted from ChatApp.tsx (P134).
 */
export type ResolveCollabSidebarDerivedCtx = Record<string, any>

export function resolveSessionRowTaskId(ctx: ResolveCollabSidebarDerivedCtx): string {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return ''
  const row = ctx.sessions.find((s) => String(s.sessionKey || '') === sk)
  return ctx.resolveSessionTaskId(
    row as { collabTaskId?: string | null } | undefined,
    ctx.boundTaskId || '',
  )
}

export function resolveChatThreadIdForSidebar(ctx: ResolveCollabSidebarDerivedCtx) {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return null
  const fromMap = ctx.wsClient.getSessionThreadId(sk)
  if (fromMap && !fromMap.startsWith('agent:')) return fromMap
  const fromRowRaw = String(
    ctx.sessions.find((s) => String(s.sessionKey || '') === sk)?.threadId || '',
  ).trim()
  const fromRow =
    ctx.resolveLanggraphLeadThreadId(fromRowRaw) ||
    (fromRowRaw && !fromRowRaw.startsWith('agent:') ? fromRowRaw : '')
  return fromRow || fromMap
}

export function resolveWorkflowTaskId(ctx: ResolveCollabSidebarDerivedCtx): string {
  const fromSubParent = String(
    (ctx.threadPanelState.collabSubtasks || []).find((s) => String(s.parentTaskId || '').trim())
      ?.parentTaskId || '',
  ).trim()
  return (
    ctx.sessionRowTaskId ||
    String(ctx.boundTaskId || '').trim() ||
    String(ctx.threadPanelState.collabTask?.taskId || '').trim() ||
    String(ctx.threadPanelState.boundTaskId || '').trim() ||
    fromSubParent
  )
}

export function resolveCollabWorkflowApiReady(ctx: ResolveCollabSidebarDerivedCtx): boolean {
  if (ctx.sessionRowTaskId) return true
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (sk.startsWith('agent:')) return true
  const thread = String(ctx.chatThreadIdForSidebar || '').trim()
  return !!(thread && !thread.startsWith('agent:'))
}

export function resolveCollabExecPanelCanShow(ctx: ResolveCollabSidebarDerivedCtx): boolean {
  if (!ctx.collabWorkflowApiReady) return false
  const task = ctx.threadPanelState.collabTask
  const planGoal = String(task?.planGoal || task?.boundPlanPreview || '').trim()
  const sidebarOpts = {
    boundPlanReady: task?.boundPlanReady,
    hasPlanBody: !!task?.boundPlanReady || !!planGoal,
  }
  const phase = String(ctx.threadPanelState.collabPhase || '').trim().toLowerCase()
  if (phase === 'executing' || phase === 'verifying' || phase === 'reflecting') return true
  if (task && ctx.isActiveExecTaskStatus(task.status)) return true
  if (ctx.collabSubtasksTaskId && ctx.shouldShowCollabWorkflowPanel(task, sidebarOpts)) return true
  return ctx.shouldShowCollabSubtaskSidebar(task, sidebarOpts)
}
