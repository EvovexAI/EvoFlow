// @ts-nocheck — mechanical P113 extract.
/**
 * Load session artifacts / platform entries when selected session changes. Extracted (P113).
 */
export type LoadSessionArtifactsCtx = Record<string, any>

export function runLoadSessionArtifactsEffect(
  ctx: LoadSessionArtifactsCtx,
): void | (() => void) {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) {
    ctx.setSessionArtifacts([])
    ctx.setSessionPlatformEntries([])
    ctx.turnPlatformEntriesRef.current = []
    ctx.setPlatformFocusEntryId('')
    ctx.setTurnArtifacts([])
    ctx.setArtifactFocusId('')
    ctx.setTurnPlatformEntries([])
    return
  }
  let cancelled = false
  ctx.setSessionArtifacts([])
  ctx.setSessionPlatformEntries([])
  ctx.turnPlatformEntriesRef.current = []
  ctx.setPlatformFocusEntryId('')
  ctx.setTurnArtifacts([])
  ctx.setArtifactFocusId('')
  ctx.setTurnPlatformEntries([])
  void ctx
    .evoflowInvokeGatewayJson(`/api/chat/sessions/${encodeURIComponent(sk)}/artifacts`)
    .then((data: { items?: unknown } | null) => {
      if (cancelled) return
      const all = ctx.normalizeChatArtifacts(data?.items)
      const platformEntries = ctx.platformRunEntriesFromChatArtifacts(
        all.filter((it: { type?: string }) => it.type === 'platform'),
      )
      ctx.turnPlatformEntriesRef.current = []
      ctx.setTurnPlatformEntries([])
      ctx.setSessionPlatformEntries(platformEntries)
      const files = all.filter((it: { type?: string }) => it.type !== 'platform')
      // 产物路径补绝对路径（历史落库的相对路径同样要能打开）
      void import('../../../lib/artifact-absolute-path.js')
        .then((m) =>
          m.withAbsoluteArtifactPaths(files, {
            threadId: ctx.wsClient?.getSessionThreadId?.(sk),
          }),
        )
        .then((absFiles: Array<Record<string, any>>) => {
          if (cancelled) return
          ctx.setSessionArtifacts(absFiles)
        })
        .catch(() => {
          if (!cancelled) ctx.setSessionArtifacts(files)
        })
    })
    .catch(() => {
      if (!cancelled) {
        ctx.setSessionArtifacts([])
        ctx.setSessionPlatformEntries([])
        ctx.turnPlatformEntriesRef.current = []
      }
    })
  return () => {
    cancelled = true
  }
}
