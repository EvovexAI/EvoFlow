/**
 * Layer 3 — Stop orchestration
 * 侧栏「停止执行」与 Composer 停止共用此入口。
 */

import {
  getSessionRuntime,
  resetRuntimeStream,
} from '../session-runtime-store.js'
import { commitPriorTurnStripFromStreamTurn } from '../turn-text-isolation.js'
import { beginSessionUserStop, finishSessionRunIdle } from './commands.js'
import { sealSessionPartialTurnOnStop } from './seal-partial-turn.js'
import type { SessionStopHost, StopSessionOptions } from './types.js'

const REATTACH_COOLDOWN_AFTER_USER_STOP_MS = 90_000

export async function stopSessionExecution(
  sessionKey: string,
  host: SessionStopHost,
  opts: StopSessionOptions = {},
): Promise<void> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return

  host.onUserStopStarted?.()
  const { runtime: rtAtStop, stopRunId: stopRunIdAtStop } = beginSessionUserStop(sk)
  commitPriorTurnStripFromStreamTurn(rtAtStop, rtAtStop.stream.turn)

  void import('../../../lib/speech-client.js')
    .then(({ stopAssistantSpeech }) => stopAssistantSpeech())
    .catch(() => {})

  const { api } = await import('../../../lib/tauri-api.js')
  try {
    // 本地 SSE wire abort（skipRunIdle：后端 execution/stop 统一写终态 run_status）
    await api.chatAbort(sk, undefined, { userInitiated: true, skipRunIdle: true })
    await api.stopSessionExecution(sk, { userInitiated: true })

    if (opts.showToast !== false) {
      host.toast?.('已停止执行', 'info')
    }
  } finally {
    const isForeground = host.isForegroundSession(sk)
    if (isForeground) {
      sealSessionPartialTurnOnStop(sk, { stopRunId: stopRunIdAtStop })
      host.onForegroundStopComplete({ sessionKey: sk, stopRunId: stopRunIdAtStop })
    } else {
      host.onBackgroundStopComplete?.({ sessionKey: sk, stopRunId: stopRunIdAtStop })
      resetRuntimeStream(getSessionRuntime(sk), undefined)
    }

    finishSessionRunIdle(sk, {
      stopRunId: stopRunIdAtStop,
      reattachCooldownMs: REATTACH_COOLDOWN_AFTER_USER_STOP_MS,
    })
    host.deleteLiveRunSnapshot?.(sk)
    host.onSessionRunEnded?.(sk, { terminalStatus: 'cancelled', reason: 'user_stop' })
    host.onUserStopFinished?.()

    if (isForeground) {
      void host.onReloadHistory?.(sk)
    }
    host.onScheduleRuntimeBump?.()
    // 须在 optimistic patch 之后刷新，避免 try 内 refresh 与 finally 竞态把 run_status 拉回 running
    void host.onRefreshSessions?.()
  }
}
