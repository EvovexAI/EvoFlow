/**
 * Focus + interval self-heal for shell session list / selected session refresh.
 * Extracted from ChatApp.tsx (P73).
 */
import {
  getSessionRuntime,
  isSessionRuntimeLive,
} from '../../lib/session-runtime-store.js'
import { isEvoflowChatV4Enabled, isV4DisplayAuthoritative } from '../../v4/v4Gate.js'
import { wsClient } from '../../../lib/ws-client.js'

export type InstallShellSessionHealCtx = {
  sessionRef: { current: string }
  refreshSessions: () => void | Promise<unknown>
  runShellSessionRefresh: (sk: string) => void | Promise<unknown>
  onShellRefreshSessionList: () => void | Promise<unknown>
  turnBusyForSession: (sk: string) => boolean
}

/**
 * Returns a cleanup function (remove focus listener + clear interval).
 */
export function installShellSessionHeal(ctx: InstallShellSessionHealCtx): () => void {
  let disposed = false
  const heal = () => {
    if (disposed) return
    void Promise.resolve(ctx.onShellRefreshSessionList()).catch(() => {})
  }
  const healSelectedSession = () => {
    const sel = ctx.sessionRef.current
    if (!sel) {
      heal()
      return
    }
    // 会话列表始终刷（轻量）；单会话对账仅在非流式时执行
    void Promise.resolve(ctx.refreshSessions()).catch(() => {})
    try {
      const rt = getSessionRuntime(sel)
      // live POST 未关或本地仍 busy/live：dbOnly 刷新会清 pin / 误 TURN_IDLE
      if (
        isSessionRuntimeLive(rt) ||
        ctx.turnBusyForSession(sel) ||
        rt.streamWireSource === 'run'
      ) {
        return
      }
      // V4 已权威上屏：60s/focus heal 勿再 bypassCache 拉旧 /messages（3–7s + setRows longtask）
      if (isEvoflowChatV4Enabled()) {
        const tid = String(wsClient.getSessionThreadId?.(sel) || '').trim()
        if (tid && isV4DisplayAuthoritative(tid)) return
      }
    } catch {
      /* store 不可达时按原行为刷新 */
    }
    void Promise.resolve(ctx.runShellSessionRefresh(sel)).catch(() => {})
  }
  const onFocus = () => {
    healSelectedSession()
  }
  window.addEventListener('focus', onFocus)
  const timer = window.setInterval(healSelectedSession, 60_000)
  return () => {
    disposed = true
    window.removeEventListener('focus', onFocus)
    window.clearInterval(timer)
  }
}
