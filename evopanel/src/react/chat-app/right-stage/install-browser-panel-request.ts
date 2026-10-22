// @ts-nocheck — mechanical P120 extract.
/**
 * Listen for Tauri `browser-panel-request` (Rust CDP) and open/ensure browser stage.
 * Extracted from ChatApp.tsx (P120).
 */
export type InstallBrowserPanelRequestCtx = Record<string, any>

export function runBrowserPanelRequestEffect(ctx: InstallBrowserPanelRequestCtx): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return () => {}
  }
  let cancelled = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ threadId?: string; url?: string }>('browser-panel-request', (ev) => {
        if (cancelled) return
        const tid =
          String(ev.payload?.threadId || '').trim() || ctx.NODE_REPL_BRIDGE_THREAD_ID
        const url = String(ev.payload?.url || '').trim()
        ctx.dbgLog(`[chat-app] browser-panel-request thread=${tid} url=${url || '(none)'}`)
        ctx.setBrowserPanelThreadId(tid)
        if (url && /^https?:\/\//i.test(url)) {
          ctx.applyBrowserCommandResponse({ threadId: tid, pageUrl: url })
        } else {
          ctx.ensureBrowserStage({
            sessionKey: ctx.rightStageSessionKeyRef.current || undefined,
          })
        }
      }),
    )
    .then((fn) => {
      if (cancelled) {
        fn()
        return
      }
      unlisten = fn
    })
    .catch((err) => {
      ctx.dbgLog(`[chat-app] browser-panel-request listen failed: ${String(err)}`)
    })
  return () => {
    cancelled = true
    unlisten?.()
  }
}
