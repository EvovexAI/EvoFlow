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
    if (ctx.platformFeedbackSeenRef) ctx.platformFeedbackSeenRef.current = new Set()
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
  // 切会话：清空平台 toast 去重，再用落库条目播种，避免历史扫描再弹一遍
  if (ctx.platformFeedbackSeenRef) ctx.platformFeedbackSeenRef.current = new Set()
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
      if (ctx.platformFeedbackSeenRef) {
        for (const row of platformEntries) {
          const id = String(row?.toolCallId || row?.id || '').trim()
          if (id) ctx.platformFeedbackSeenRef.current.add(id)
        }
      }
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
