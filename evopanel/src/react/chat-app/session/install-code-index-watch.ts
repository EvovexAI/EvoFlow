/**
 * Background code-index warm + watch for project / virtual workspace.
 * Extracted from ChatApp.tsx (P79).
 */

export type InstallProjectCodeIndexWatchCtx = {
  workspaceIndexWatchEnabled: boolean
  useVirtualPaths: boolean
  effectiveWorkspaceRoot: string
}

/** Project-root index watch. Returns cleanup or no-op. */
export function installProjectCodeIndexWatch(
  ctx: InstallProjectCodeIndexWatchCtx,
): () => void {
  if (!ctx.workspaceIndexWatchEnabled) return () => {}
  if (ctx.useVirtualPaths) return () => {}
  const root = ctx.effectiveWorkspaceRoot
  if (!root) return () => {}
  let cancelled = false
  void (async () => {
    try {
      const { api } = await import('../../../lib/tauri-api.js')
      if (cancelled) return
      void api.warmCodeIndex(root, false, undefined)
      await api.startCodeIndexWatch(root, undefined)
    } catch {
      /* best-effort index warm-up */
    }
  })()
  return () => {
    cancelled = true
    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        await api.stopCodeIndexWatch(root, undefined)
      } catch {
        /* ignore */
      }
    })()
  }
}

export type InstallVirtualCodeIndexWatchCtx = {
  workspaceIndexWatchEnabled: boolean
  useVirtualPaths: boolean
  threadId: string
}

/** Virtual-path (thread) index watch. Returns cleanup or no-op. */
export function installVirtualCodeIndexWatch(
  ctx: InstallVirtualCodeIndexWatchCtx,
): () => void {
  if (!ctx.workspaceIndexWatchEnabled) return () => {}
  if (!ctx.useVirtualPaths) return () => {}
  const threadId = String(ctx.threadId || '').trim()
  if (!threadId) return () => {}
  let cancelled = false
  void (async () => {
    try {
      const { api } = await import('../../../lib/tauri-api.js')
      if (cancelled) return
      void api.warmCodeIndex('', false, threadId)
      await api.startCodeIndexWatch('', threadId)
    } catch {
      /* best-effort */
    }
  })()
  return () => {
    cancelled = true
    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        await api.stopCodeIndexWatch('', threadId)
      } catch {
        /* ignore */
      }
    })()
  }
}
