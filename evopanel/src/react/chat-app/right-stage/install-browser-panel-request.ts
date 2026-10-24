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
  // Tell main.js early/boot listeners to skip stage UI (they still create HWND).
  // Without this, one Rust emit → early + boot + chat-app each open the panel.
  ;(window as unknown as { __EVOFLOW_CHAT_BROWSER_PANEL__?: boolean }).__EVOFLOW_CHAT_BROWSER_PANEL__ =
    true
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ threadId?: string; url?: string }>('browser-panel-request', (ev) => {
        if (cancelled) return
        const tid =
          String(ev.payload?.threadId || '').trim() || ctx.NODE_REPL_BRIDGE_THREAD_ID
        const url = String(ev.payload?.url || '').trim()
        // Attribute to bridge owner (session that started browser tools), not the
        // chat the user happens to be viewing — otherwise A→B switch steals the UI.
        const ownerSk =
          typeof ctx.getBridgeOwnerSessionKey === 'function'
            ? String(ctx.getBridgeOwnerSessionKey() || '').trim()
            : ''
        const sessionKey = ownerSk || ctx.rightStageSessionKeyRef.current || undefined
        ctx.dbgLog(
          `[chat-app] browser-panel-request thread=${tid} url=${url || '(none)'} session=${sessionKey || '(none)'}`,
        )
        void import('../../../lib/browser-unified-log.js')
          .then(({ blogTimeline }) =>
            blogTimeline(
              '侧栏打开',
              `来源=后台提示 线程=${tid} 链接=${url || '(无)'} 会话=${sessionKey || '(无)'}`,
            ),
          )
          .catch(() => {})
        ctx.setBrowserPanelThreadId(tid)
        // Soft-decouple: raise right-stage UI; HWND navigate stays with CDP.
        // applyBrowserCommandResponse 在 needRaise 时已 ensure（skipHwndNav）；
        // 无 URL 时再单独 ensure，避免同一事件双重 bump 叠进 V4 帧提交。
        const httpUrl = url && /^https?:\/\//i.test(url) ? url : ''
        if (httpUrl) {
          ctx.applyBrowserCommandResponse({
            threadId: tid,
            pageUrl: httpUrl,
            sessionKey,
            navigateIntent: false,
          })
        } else {
          ctx.ensureBrowserStage({
            sessionKey,
            skipHwndNav: true,
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
    ;(window as unknown as { __EVOFLOW_CHAT_BROWSER_PANEL__?: boolean }).__EVOFLOW_CHAT_BROWSER_PANEL__ =
      false
    unlisten?.()
  }
}
