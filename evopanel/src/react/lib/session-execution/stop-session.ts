/**
 * Layer 3 — Stop orchestration
 * 侧栏「停止执行」与 Composer 停止共用此入口。
 */

import {
  getSessionRuntime,
  resetRuntimeStream,
} from '../session-runtime-store.js'
import { logStreamStop } from '../stream-stop-log.js'
import { commitPriorTurnStripFromStreamTurn } from '../turn-text-isolation.js'
import { beginSessionUserStop, finishSessionRunIdle } from './commands.js'
import { sealSessionPartialTurnOnStop } from './seal-partial-turn.js'
import type { SessionStopHost, SessionStopSource, StopSessionOptions } from './types.js'

const REATTACH_COOLDOWN_AFTER_USER_STOP_MS = 90_000

const STOP_SOURCE_ZH: Record<SessionStopSource, string> = {
  composer_stop_button: '用户点击 Composer 停止按钮',
  shell_sidebar_stop: '用户点击侧栏停止',
  v4_stop_button: '用户点击 V4 停止按钮',
  v4_escape: '用户按 Esc 停止',
  interrupt_send_steers: '打断重发·纠偏指令（先停当前回合再发）',
  interrupt_flush_queue: '打断重发·排队消息（先停当前回合再发）',
  page_load_stale_stop: '页面加载发现过期 run，自动停止',
  employee_process_pane: '员工进程面板停止按钮',
  unknown: '未标注来源的停止（兼容旧调用；请补 source）',
}

export function sessionStopSourceZh(source: SessionStopSource): string {
  return STOP_SOURCE_ZH[source] || STOP_SOURCE_ZH.unknown
}

export async function stopSessionExecution(
  sessionKey: string,
  host: SessionStopHost,
  opts: StopSessionOptions = {},
): Promise<void> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return

  const source: SessionStopSource = opts.source || 'unknown'
  const whoZh = sessionStopSourceZh(source)

  host.onUserStopStarted?.()
  const { runtime: rtAtStop, stopRunId: stopRunIdAtStop } = beginSessionUserStop(sk)
  logStreamStop({
    sessionKey: sk,
    runId: stopRunIdAtStop,
    trigger: source,
    hasEndMarker: false,
    fromUiStopButton: true,
    detail: {
      source,
      whoZh,
      turnPhase: rtAtStop.turnPhase,
      showToast: opts.showToast !== false,
      note: `主动停止路径：${whoZh}`,
    },
  })
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
