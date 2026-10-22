// @ts-nocheck — mechanical P117 extract.
/**
 * New-session / open-home / workspace-scoped new chat helpers. Extracted (P117).
 */
export type NewSessionActionsCtx = Record<string, any>

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
  ctx.startNewSessionWithWorkspace(ctx.resolveWorkspaceForNewSession())
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
