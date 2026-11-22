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

    // ZCode 对齐：轮询 /api/cua/glow-status，电脑控制时顶栏「正在操作电脑」。
    // 不依赖 panel-stream / AG-UI（V4 下更稳）；日志进 plugin-control.log [cua-glow]。
    void import('../../../lib/cua-glow-poll.js').then((m) => m.startCuaGlowStatusPoll())

    // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    // 提示条上的「解除控制」→ Rust emit cua-glow-user-stop → 这里真正停掉会话。
    // 为什么在这里接：提示条是独立 webview，拿不到主窗口的会话上下文；
    // 主窗口是唯一知道 sessionKey 的地方，停止链路也在这里现成可用。
    let detachCuaStop = () => {}
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { gatewayProxy } = await import('../../../lib/tauri-api.js')
        const un = await listen('cua-glow-user-stop', () => {
          void (async () => {
            try {
              // 先读状态拿 session_key：多会话并行时不能凭猜停错人。
              // 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
              // 这里原来读 thread_id 当 sessionKey 用 —— 那是 LangGraph 的 UUID
              // （ae5615a4-…），而 chatAbort / execution/stop 只认 session_key
              // （agent:main:new-…）。实测库里两者格式完全不同，所以旧代码点了
              // 「解除控制」其实停不掉任何会话（用户只看到指示器消失）。
              const st = await gatewayProxy('GET', '/cua/glow-status', null, null, {
                silent: true,
                skipRetry: true,
                skipDedup: true,
                __probe__: true,
              })
              const sk = String(st?.session_key || '').trim()
              if (!sk) {
                // 【self-evolution-bot · 2026-11-19 · 第72轮】原来是直接 return ——
                // 状态里读不到 session_key 时按钮**完全没反应**（用户点了以为坏了）。
                // 收回控制权不该依赖会话标识：拿不到就按全局收回，宁可多拦一层。
                // 代价：全局收回后不会按「新消息」自动恢复（没有 seq 水位可比），
                // 由用户下一次点按钮之外的动作或重启状态复位 —— 但这比点了没反应好。
                console.warn('[cua-glow] user-stop: no session_key, revoking globally')
              }
              // 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
              // 用户原话纠正（上一轮我接错了）：「这个停止只是停止电脑控制，
              // 并不是停止AI啊。只是电脑控制这个插件，当前是取消电脑控制了」。
              //
              // 所以这里**不能**调 stopSessionExecution / chatAbort —— 那是掐整个
              // LangGraph run，AI 这一轮的回答会被硬切断，跟按钮语义完全不符。
              // 正确做法：只调 /cua/control/revoke，收回电脑操作权；
              // 后端拦住后续 CUA 调用并把原因告诉模型，AI 该继续答就继续答。
              await gatewayProxy('POST', '/cua/control/revoke', { session_key: sk }, null, {
                silent: true,
                skipRetry: true,
                skipDedup: true,
                __probe__: true,
              })
              console.info(`[cua-glow] control revoked session=${sk} (AI 回合未停止)`);
            } catch (err) {
              console.warn(`[cua-glow] user-stop failed: ${String(err?.message || err)}`)
            } finally {
              // 无论停止是否成功，指示器必须立刻消失（用户点了 / 按了 ESC 就得有反馈）。
              try {
                const overlay = await import('../../../lib/cua-glow-overlay.js')
                await overlay.hideCuaGlowOverlayForced?.()
              } catch {
                /* ignore */
              }
              const mod = await import('../../../lib/cua-glow-poll.js').catch(() => null)
              await mod?.clearCuaGlowStatusRemote?.()
            }
          })()
        })
        detachCuaStop = () => {
          try {
            un()
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        console.warn(`[cua-glow] user-stop listen failed: ${String(err?.message || err)}`)
      }
    })()
    
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
      const detail = (
        ev as CustomEvent<{
          sessionKey?: string
          threadId?: string
          oldThreadId?: string
          force?: boolean
          reason?: string
        }>
      ).detail
      const sk = String(detail?.sessionKey || '').trim()
      const tid = String(detail?.threadId || '').trim()
      if (!sk || !tid) return
      const force = !!detail?.force
      const reason = String(detail?.reason || '').trim()
      const oldTid = String(detail?.oldThreadId || '').trim()
      // 必须在 setSessions（进而换 selectedThreadId）之前同步改挂，
      // 否则 V4StreamRowsBridge 会 cold acquire 清空时间线。
      if (force && oldTid && oldTid !== tid) {
        try {
          const w = window as Window & {
            __evoflowRebindV4OnRemint?: (a: string, b: string) => boolean
          }
          w.__evoflowRebindV4OnRemint?.(oldTid, tid)
        } catch {
          /* best effort */
        }
      }
      setSessions((prev) => {
        let changed = false
        const next = prev.map((s) => {
          if (String(s.sessionKey || '') !== sk) return s
          const cur = String(s.threadId || '').trim()
          // 已有不同 lead 且非强制：拒绝覆盖，避免打开历史时 V4 sessionId 连跳转圈
          if (cur && cur !== tid && !force) {
            console.warn('[v4] ignore thread rebound thrash', {
              sessionKey: sk,
              keep: cur,
              ignored: tid,
              reason: reason || 'unforced',
            })
            return s
          }
          if (cur === tid) return s
          changed = true
          return { ...s, threadId: tid }
        })
        return changed ? next : prev
      })
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
      // 【self-evolution-bot · 2026-11-19 · 第68轮】摘掉提示条「解除控制」监听，避免热更/卸载后残留。
      detachCuaStop()
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
