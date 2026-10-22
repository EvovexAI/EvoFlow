// @ts-nocheck — mechanical extract.
/**
 * ChatApp mount bootstrap: connect WS, modes, shell panel SSE, session title events. Extracted (P85).
 */
export type RunChatMountBootstrapEffectCtx = Record<string, any>

export function runChatMountBootstrapEffect(ctx: RunChatMountBootstrapEffectCtx): void | (() => void) {
  const {
    getApi,
    isPlaceholderSessionTitle,
    loadModelCatalog,
    patchSessionTitleInRows,
    pickSessionRowTitle,
    refreshSpeechConfigured,
    reviveAllTurnBusyIfLivePostOpen,
    scheduleRefreshSessions,
    sessionsRef,
    setChatSurfaceVisible,
    setDynamicModes,
    setSessionNamesTick,
    setSessions,
    setSessionTitle,
    syncSessionRowRef,
    wsClient,
  } = ctx
    try {
      localStorage.removeItem('evopanel-chat-selected-session')
    } catch {
      /* ignore */
    }
    if (!wsClient.connected) wsClient.connect()
    void loadModelCatalog()
    // 从后端加载模式定义（动态控制显示项）
    void (async () => {
      try {
        const api = await getApi()
        const resp = await api.getSessionModes()
        if (resp?.modes && Array.isArray(resp.modes)) {
          setDynamicModes(
            resp.modes.map((m: any) => ({
              value: String(m.value || ''),
              label: String(m.label || m.value || ''),
              visible: m.visible !== false,
              scenario: m.scenario ?? null,
            })),
          )
        }
      } catch {
        /* 降级使用 DEFAULT_SESSION_MODES */
      }
    })()
    // Let /messages + /models win the first seconds after mount (stdio/GIL contention).
    scheduleRefreshSessions(1500)
    const u1 = wsClient.onReady(() => {
      scheduleRefreshSessions(1800)
    })

    // 后台派发/值班新建员工会话时推 panel:session_upserted → 侧栏重拉
    // 窗口隐藏时断开 shell panel SSE，避免 Mac 后台仍保活重连。
    let unsubShellPanel: (() => void) | null = null
    let shellPanelCancelled = false
    const disconnectShellPanel = () => {
      try {
        unsubShellPanel?.()
      } catch {
        /* ignore */
      }
      unsubShellPanel = null
    }
    const connectShellPanel = () => {
      if (shellPanelCancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      disconnectShellPanel()
      void import('../../../lib/ws-client.js').then(({ subscribeThreadPanelSse }) => {
        if (shellPanelCancelled) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        unsubShellPanel = subscribeThreadPanelSse('__evopanel_shell__', (dataJson: string) => {
          try {
            const ev = JSON.parse(String(dataJson || '{}'))
            if (String(ev?.type || '').trim() !== 'panel:session_upserted') return
            const data = ev?.data && typeof ev.data === 'object' ? ev.data : ev
            const sk = String(data?.session_key || data?.sessionKey || '').trim()
            if (!sk) return
            if (sessionsRef.current.some((s) => String(s.sessionKey || '') === sk)) return
            void syncSessionRowRef.current?.(sk)
          } catch {
            /* ignore */
          }
        })
      })
    }
    const onShellPanelVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        disconnectShellPanel()
      } else {
        connectShellPanel()
      }
    }
    connectShellPanel()
    document.addEventListener('visibilitychange', onShellPanelVisibility)
    
    // 监听会话名称更新事件
    const onNameUpdate = (ev?: Event) => {
      setSessionNamesTick((t) => t + 1)
      const detail = (ev as CustomEvent<{ sessionKey?: string; title?: string }> | undefined)?.detail
      const sk = String(detail?.sessionKey || '').trim()
      const title = String(detail?.title || '').trim()
      if (sk && title) {
        setSessions((prev) => patchSessionTitleInRows(prev, sk, title))
        return
      }
      setSessions((prev) => {
        let changed = false
        const next = prev.map((s) => {
          const key = String(s.sessionKey || '').trim()
          if (!key) return s
          const picked = pickSessionRowTitle(key, s.title, s.title)
          if (picked && picked !== s.title) {
            changed = true
            return { ...s, title: picked }
          }
          return s
        })
        return changed ? next : prev
      })
    }
    window.addEventListener('session-name-updated', onNameUpdate)

    const onThreadRebound = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; threadId?: string }>).detail
      const sk = String(detail?.sessionKey || '').trim()
      const tid = String(detail?.threadId || '').trim()
      if (!sk || !tid) return
      setSessions((prev) =>
        prev.map((s) => (String(s.sessionKey || '') === sk ? { ...s, threadId: tid } : s)),
      )
    }
    window.addEventListener('evopanel:session-thread-rebound', onThreadRebound)

    const onPanelTitleUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; title?: string }>).detail
      const sk = String(detail?.sessionKey || '').trim()
      const title = String(detail?.title || '').trim()
      if (!sk || !title || isPlaceholderSessionTitle(title)) return
      setSessionTitle(sk, title)
      setSessions((prev) => patchSessionTitleInRows(prev, sk, title))
    }
    window.addEventListener('evopanel:session-title-updated', onPanelTitleUpdated)

    const onModelsUpdated = () => {
      void loadModelCatalog({ silent: true, forceLive: true })
    }
    const onMediaUpdated = () => {
      refreshSpeechConfigured()
    }
    const onChatRouteShown = () => {
      setChatSurfaceVisible(true)
      try {
        const host = document.getElementById('chat-persistent-host')
        if (host) {
          host.hidden = false
          host.style.display = 'flex'
        }
      } catch {
        /* ignore */
      }
      // 切回 #/chat：恢复所有仍挂着 live POST 却被误 idle 的会话（含后台「绘画」）
      reviveAllTurnBusyIfLivePostOpen()
      void loadModelCatalog({ silent: true, forceLive: true })
      refreshSpeechConfigured()
    }
    refreshSpeechConfigured()
    window.addEventListener('evopanel:models-updated', onModelsUpdated)
    window.addEventListener('evopanel:media-updated', onMediaUpdated)
    window.addEventListener('evopanel:chat-route-shown', onChatRouteShown)
    
    return () => {
      shellPanelCancelled = true
      u1()
      document.removeEventListener('visibilitychange', onShellPanelVisibility)
      disconnectShellPanel()
      window.removeEventListener('session-name-updated', onNameUpdate)
      window.removeEventListener('evopanel:session-thread-rebound', onThreadRebound)
      window.removeEventListener('evopanel:session-title-updated', onPanelTitleUpdated)
      window.removeEventListener('evopanel:models-updated', onModelsUpdated)
      window.removeEventListener('evopanel:media-updated', onMediaUpdated)
      window.removeEventListener('evopanel:chat-route-shown', onChatRouteShown)
    }
}
