/**
 * Resolve workspace hint + open-home guard for new sessions.
 * Extracted from ChatApp.tsx (P58).
 */
import type { MutableRefObject } from 'react'
import type { DisplayRow } from '../../chat-types.js'

export type ResolveWorkspaceForNewSessionCtx = {
  shellIntentWorkspaceRef: MutableRefObject<string | null | undefined>
  localWorkspaceRootRef: MutableRefObject<string | null | undefined>
}

export function resolveWorkspaceForNewSession(
  ctx: ResolveWorkspaceForNewSessionCtx,
): string | null {
  if (ctx.shellIntentWorkspaceRef.current !== undefined) {
    const intent = String(ctx.shellIntentWorkspaceRef.current || '').trim()
    return intent || null
  }
  const cur = String(ctx.localWorkspaceRootRef.current || '').trim()
  return cur || null
}

export type ShouldStayOnHomeCtx = {
  historyLoading: boolean
  historyError: unknown
  sessionHadContent: boolean
  rowsRef: MutableRefObject<DisplayRow[]>
  selectedTurnBusy: boolean
}

export function shouldStayOnHomeDashboard(ctx: ShouldStayOnHomeCtx): boolean {
  return (
    !ctx.historyLoading &&
    !ctx.historyError &&
    !ctx.sessionHadContent &&
    Array.isArray(ctx.rowsRef.current) &&
    ctx.rowsRef.current.length === 0 &&
    !ctx.selectedTurnBusy
  )
}

export function scrollHomeMessagesToTop(): void {
  try {
    document
      .querySelector('.chat-messages-inner--home')
      ?.scrollTo?.({ top: 0, behavior: 'smooth' })
  } catch {
    /* ignore */
  }
}
