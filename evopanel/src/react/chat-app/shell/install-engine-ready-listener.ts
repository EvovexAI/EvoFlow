// @ts-nocheck — mechanical P125 extract.
/**
 * Subscribe to Tauri backend-ready and refresh agents when engine comes up.
 * Extracted from ChatApp.tsx (P125).
 */
export type InstallEngineReadyListenerCtx = Record<string, any>

export function runEngineReadyListenerEffect(ctx: InstallEngineReadyListenerCtx): () => void {
  let unsub: (() => void) | undefined
  let cancelled = false
  void import('../../../lib/tauri-api.js').then(async (mod) => {
    const initial = mod.isBackendReady()
    if (initial === true) ctx.setEngineReady(true)
    else if (initial === false) ctx.setEngineReady(false)
    else {
      // 尚未探测：先拉一次，避免 UI-first 下误开发送
      try {
        const ok = await mod.checkBackendReady()
        if (!cancelled) ctx.setEngineReady(!!ok)
      } catch {
        if (!cancelled) ctx.setEngineReady(false)
      }
    }
    unsub = mod.onBackendReadyChange((v) => {
      ctx.setEngineReady(!!v)
      if (v) void ctx.refreshAgentsList()
    })
  })
  return () => {
    cancelled = true
    unsub?.()
  }
}
