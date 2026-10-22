// @ts-nocheck — mechanical P88 extract.
/**
 * Per-session thread panel SSE (activity + title). Extracted from ChatApp.tsx (P88).
 */
export type InstallThreadPanelSseCtx = Record<string, any>

export function runThreadPanelSseEffect(ctx: InstallThreadPanelSseCtx): void | (() => void) {
  const {
    applyStreamTurnEvent,
    scheduleBumpRef,
    selectedSessionKey,
    sessions,
    setSessionActivity,
    streamRef,
    wsClient,
  } = ctx
  const sk = String(selectedSessionKey || '').trim()
  if (!sk) return
  const row = sessions.find((s) => String(s.sessionKey || '') === sk)
  const tid = String(wsClient.getSessionThreadId(sk) || row?.threadId || '').trim()
  if (!tid) return
  let cancelled = false
  let unsubPanel: (() => void) | null = null
  const disconnectPanel = () => {
    try {
      unsubPanel?.()
    } catch {
      /* ignore */
    }
    unsubPanel = null
  }
  const connectPanel = () => {
    if (cancelled) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    disconnectPanel()
    void import('../../../lib/ws-client.js').then(({ subscribeThreadPanelSse }) => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      unsubPanel = subscribeThreadPanelSse(tid, (dataJson: string) => {
        try {
          const ev = JSON.parse(String(dataJson || '{}'))
          const evType = String(ev?.type || '').trim()
          if (evType === 'panel:activity') {
            // 后台 run（proactive 值班等）无 live runs/stream：步骤进度经
            // panel-stream 控制面到达。走与 thread_state 活动相同的管线，
            // 驱动 session 状态条 + 流式行 spinner 文案（B1/B2 通路前端端）。
            const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
            const detail = String(data.detail || '').trim()
            if (!detail) return
            const kind = String(data.kind || 'system').trim().toLowerCase()
            setSessionActivity(sk, kind === 'idle' ? 'system' : kind, detail)
            applyStreamTurnEvent(streamRef.current, { type: 'system_activity', detail })
            scheduleBumpRef.current?.({ immediate: true })
            return
          }
          if (evType !== 'panel:title_updated') return
          const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
          const title = String(data.title || '').trim()
          const sessionKey = String(data.session_key || data.sessionKey || sk).trim()
          if (!title || !sessionKey) return
          window.dispatchEvent(
            new CustomEvent('evopanel:session-title-updated', {
              detail: { sessionKey, title },
            }),
          )
        } catch {
          /* ignore malformed panel SSE */
        }
      })
    })
  }
  const onVis = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      disconnectPanel()
    } else {
      connectPanel()
    }
  }
  connectPanel()
  document.addEventListener('visibilitychange', onVis)
  return () => {
    cancelled = true
    document.removeEventListener('visibilitychange', onVis)
    disconnectPanel()
  }
}
