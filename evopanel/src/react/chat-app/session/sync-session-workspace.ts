/**
 * Session workspace-updated event + hydrate workspace history on session switch.
 * Extracted from ChatApp.tsx (P78).
 */
import type { Dispatch, SetStateAction } from 'react'

export type SyncSessionWorkspaceCtx = {
  selectedSessionKey: string
  setLocalWorkspaceRoot: (v: string) => void
  setWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  bumpStreamFull: () => void
  getWorkspaceHistory: (sk: string) => string[]
  getGlobalWorkspaceHistory: () => string[]
}

export function handleSessionWorkspaceUpdatedEvent(
  ctx: SyncSessionWorkspaceCtx,
  ev: Event,
): void {
  const d = (ev as CustomEvent<{ sessionKey?: string; local_workspace_root?: string }>).detail
  if (!d?.sessionKey || d.sessionKey !== ctx.selectedSessionKey) return
  const p = String(d.local_workspace_root || '').trim()
  if (!p) return
  ctx.setLocalWorkspaceRoot(p)
  try {
    ctx.setWorkspaceHistory(ctx.getWorkspaceHistory(ctx.selectedSessionKey))
    ctx.setGlobalWorkspaceHistory(ctx.getGlobalWorkspaceHistory())
  } catch {
    /* ignore */
  }
  ctx.bumpStreamFull()
}

export type HydrateSessionWorkspaceHistoryCtx = {
  selectedSessionKey: string
  setLocalWorkspaceRoot: (v: string) => void
  setWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  hydrateGlobalWorkspaceHistoryOnce: () => Promise<unknown>
  ensureSessionWorkspaceHistory: (sk: string) => Promise<unknown>
  getSessionContext: (sk: string) => Record<string, unknown>
  getWorkspaceHistory: (sk: string) => string[]
  getGlobalWorkspaceHistory: () => string[]
}

/** Returns cleanup that cancels in-flight hydrate. */
export function startHydrateSessionWorkspaceHistory(
  ctx: HydrateSessionWorkspaceHistoryCtx,
): () => void {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return () => {}
  let cancelled = false
  void (async () => {
    try {
      await ctx.hydrateGlobalWorkspaceHistoryOnce()
      await ctx.ensureSessionWorkspaceHistory(sk)
      if (cancelled) return
      const sessionCtx = ctx.getSessionContext(sk)
      const root = String(sessionCtx.local_workspace_root || '').trim()
      if (root) ctx.setLocalWorkspaceRoot(root)
      ctx.setWorkspaceHistory(ctx.getWorkspaceHistory(sk))
      ctx.setGlobalWorkspaceHistory(ctx.getGlobalWorkspaceHistory())
    } catch {
      /* ignore */
    }
  })()
  return () => {
    cancelled = true
  }
}
