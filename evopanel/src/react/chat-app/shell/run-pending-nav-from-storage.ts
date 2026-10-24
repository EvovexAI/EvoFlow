// @ts-nocheck — mechanical P119 extract.
/**
 * Drain sessionStorage pending new-session / open-home / agent-switch / composer draft.
 * Extracted from ChatApp.tsx (P119).
 */
export type RunPendingNavFromStorageCtx = Record<string, any>

export function runPendingNavFromStorageEffect(ctx: RunPendingNavFromStorageCtx): () => void {
  let cancelled = false
  void (async () => {
    let wantNew = false
    let wantHome = false
    let code = ''
    let pendingDraft = ''
    try {
      wantNew = sessionStorage.getItem('evopanel_pending_new_session') === '1'
      if (wantNew) sessionStorage.removeItem('evopanel_pending_new_session')
      wantHome = sessionStorage.getItem('evopanel_pending_open_home') === '1'
      if (wantHome) sessionStorage.removeItem('evopanel_pending_open_home')
      code = String(sessionStorage.getItem('evopanel_pending_agent_switch') || '').trim()
      if (code) sessionStorage.removeItem('evopanel_pending_agent_switch')
      pendingDraft = String(sessionStorage.getItem('evopanel_pending_composer_draft') || '').trim()
      if (pendingDraft) sessionStorage.removeItem('evopanel_pending_composer_draft')
    } catch {
      return
    }
    if (wantNew) await ctx.handleNewSessionRef.current?.()
    else if (wantHome) await ctx.handleOpenHomeRef.current?.()
    if (cancelled) return
    if (code) {
      try {
        await ctx.startNewChatWithPresetAgent(code)
      } catch {
        /* ignore */
      }
    }
    if (cancelled || !pendingDraft) return
    ctx.restoreComposerDraft(pendingDraft)
  })()
  return () => {
    cancelled = true
  }
}
