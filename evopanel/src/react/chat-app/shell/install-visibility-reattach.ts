// @ts-nocheck — mechanical extract.
/**
 * Visibility/online stream reattach. Extracted (P86).
 */
export type RunVisibilityReattachEffectCtx = Record<string, any>

export function runVisibilityReattachEffect(ctx: RunVisibilityReattachEffectCtx): void | (() => void) {
  const {
    evoflowFetch,
    hiddenSinceRef,
    isSessionRecoveryCooldownActive,
    refreshSessionsRef,
    requestManualStreamResumeRef,
    sessionRef,
    shouldManualRefreshResumeStream,
    shouldSuppressAutoReattach,
    srLog,
    wsClient,
  } = ctx
    let reattachTimer: ReturnType<typeof setTimeout> | null = null

    const tryReattach = () => {
      const sk = String(sessionRef.current || '').trim()
      if (!sk) return
      // Live POST /runs/stream: never reattach (would abortStreamWire the send).
      if (shouldSuppressAutoReattach({ sessionKey: sk })) return
      // Only resume when the session still looks like it needs a wire.
      if (!shouldManualRefreshResumeStream({ sessionKey: sk })) return
      if (isSessionRecoveryCooldownActive(sk)) return
      void (async () => {
        try {
          const status = await wsClient.getSessionRunStatus(sk)
          // 处理 recently_completed：如果 run 刚完成（60s 内），刷新消息列表并重置流状态
          if (status.recently_completed) {
            srLog('visibility reattach recently-completed', {
              sessionKey: sk,
              runId: status.recently_completed_run_id,
              completedStatus: status.recently_completed_status,
            })
            // 刷新会话列表以获取最新状态
            await refreshSessionsRef.current?.({ skipAutoReselect: true })
            // 清理本地运行状态标记为 idle
            try {
              await evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/run-idle`, {
                method: 'POST',
              })
            } catch {
              // best-effort
            }
            return
          }
          // R2-2: run 未在执行但有 runId，查询是否已完成
          if (!status.executing && status.runId) {
            try {
              const checkResp = await evoflowFetch(
                `/api/chat/sessions/${encodeURIComponent(sk)}/live-run/check`
              )
              if (checkResp.ok) {
                const checkData = await checkResp.json()
                if (checkData?.completed) {
                  srLog('visibility reattach completed-run', {
                    sessionKey: sk,
                    runId: status.runId,
                    completedStatus: checkData.status,
                  })
                  // 刷新消息列表获取最终结果
                  await refreshSessionsRef.current?.({ skipAutoReselect: true })
                  // 清理 live_run 记录
                  await evoflowFetch(
                    `/api/chat/sessions/${encodeURIComponent(sk)}/live-run`,
                    { method: 'DELETE' }
                  ).catch(() => {})
                  return
                }
              }
            } catch {
              // best-effort: silent failure
            }
            // Run not completed but not executing - stale run, refresh messages
            srLog('visibility reattach stale-run-refresh', {
              sessionKey: sk,
              runId: status.runId,
              status: status.status,
            })
            await refreshSessionsRef.current?.({ skipAutoReselect: true })
            return
          }
          srLog('visibility reattach', {
            sessionKey: sk,
            runId: status.runId,
          })
          requestManualStreamResumeRef.current?.(sk, { refreshSessions: false })
        } catch {
          // 静默失败
        }
      })()
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = Date.now()
      } else {
        const hiddenFor = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0
        hiddenSinceRef.current = null
        // 仅在后台超过 5 秒时触发，避免快速切换干扰
        if (hiddenFor < 5000) return

        // R2-1: Send heartbeat to backend when returning from background
        // This updates last_event_at so backend knows frontend is still alive
        const sk = String(sessionRef.current || '').trim()
        if (sk) {
          void evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/heartbeat`, {
            method: 'POST',
          }).catch(() => {
            // best-effort: silent failure
          })
        }

        // 延迟 500ms，避免与路由切换/组件重渲染竞争
        if (reattachTimer) clearTimeout(reattachTimer)
        reattachTimer = setTimeout(tryReattach, 500)
      }
    }

    const handleOnline = () => {
      // 网络恢复后延迟 1s 检测
      if (reattachTimer) clearTimeout(reattachTimer)
      reattachTimer = setTimeout(tryReattach, 1000)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      if (reattachTimer) clearTimeout(reattachTimer)
    }
}
