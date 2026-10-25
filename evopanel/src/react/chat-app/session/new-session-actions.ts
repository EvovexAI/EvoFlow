// @ts-nocheck — mechanical P117 extract.
/**
 * New-session / open-home / workspace-scoped new chat helpers. Extracted (P117).
 */
export type NewSessionActionsCtx = Record<string, any>

export function handleNewSession(ctx: NewSessionActionsCtx): void {
  ctx.startNewSessionWithWorkspace(ctx.resolveWorkspaceForNewSession())
}

/** @deprecated 逻辑已内联到 use-chat-app-controller.handleOpenHome（只切仪表盘，不 createSession） */
export function handleOpenHome(ctx: NewSessionActionsCtx): void {
  if (
    ctx.shouldStayOnHomeDashboard({
      historyLoading: ctx.historyLoading,
      historyError: ctx.historyError,
      sessionHadContent: ctx.sessionHadContent,
      rowsRef: ctx.rowsRef,
      selectedTurnBusy: ctx.selectedTurnBusy,
    })
  ) {
    ctx.scrollHomeMessagesToTop()
    return
  }
  // 兼容旧调用：仅切首页意图，不再新建会话（发消息时才 create）。
  ctx.setPreferHomeDashboard?.(true)
  ctx.setSessionHadContent?.(false)
  ctx.setSelectedSessionKey?.('')
  ctx.sessionRef && (ctx.sessionRef.current = '')
  ctx.setNewChatButtonActive?.(true)
  ctx.resetChatSurfaceForNewDraft?.()
}

export function handleNewSessionInWorkspace(
  ctx: NewSessionActionsCtx,
  workspacePath: string | null,
): void {
  const ws = String(workspacePath || '').trim()
  ctx.shellIntentWorkspaceRef.current = ws || null
  ctx.startNewSessionWithWorkspace(ws || null)
}

export function pruneDeletedSessionCaches(ctx: NewSessionActionsCtx): void {
  const keep = new Set<string>()
  for (const s of ctx.sessions) {
    const sk = String(s?.sessionKey || '').trim()
    if (sk) keep.add(sk)
  }
  const active = String(ctx.selectedSessionKey || ctx.sessionRef.current || '').trim()
  if (active) keep.add(active)
  ctx.pruneSessionRuntimes(keep)
  // 等价旧 pruneLiveStreams：用 stream-snapshot-store 的 prune 接口
  ctx.pruneStreamSnapshots(keep)
  for (const sk of [...ctx.seenArtifactsRef.current.keys()]) {
    if (!keep.has(sk)) ctx.seenArtifactsRef.current.delete(sk)
  }
}
