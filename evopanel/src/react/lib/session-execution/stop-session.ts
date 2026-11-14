/**
 * Layer 3 — Stop orchestration
 * 侧栏「停止执行」与 Composer 停止共用此入口。
 */

import {
  getSessionRuntime,
  resetRuntimeStream,
} from '../session-runtime-store.js'
import { logStreamStop, markStreamStopTrace, streamStopSinceMs } from '../stream-stop-log.js'
import { commitPriorTurnStripFromStreamTurn } from '../turn-text-isolation.js'
import { beginSessionUserStop, finishSessionRunIdle } from './commands.js'
import { sealSessionPartialTurnOnStop } from './seal-partial-turn.js'
import { logChatRuntimeTurn, logChatRuntimeUserClick } from '../chat-runtime-log.js'
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
  markStreamStopTrace({ sessionKey: sk, runId: stopRunIdAtStop, source })
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
      sinceStopMs: 0,
    },
  })
  const stopAction =
    source === 'shell_sidebar_stop'
      ? 'sidebar_stop'
      : source === 'interrupt_flush_queue' || source === 'interrupt_send_steers'
        ? 'interrupt_flush'
        : 'stop'
  logChatRuntimeUserClick({
    action: stopAction,
    whoZh,
    sessionKey: sk,
    runId: stopRunIdAtStop,
    detail: { source, turnPhase: rtAtStop.turnPhase },
  })
  logChatRuntimeTurn({
    phase: 'stop_requested',
    whoZh: `对话停止请求：${whoZh}`,
    sessionKey: sk,
    runId: stopRunIdAtStop,
    detail: { source, turnPhase: rtAtStop.turnPhase },
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

    logStreamStop({
      sessionKey: sk,
      runId: stopRunIdAtStop,
      trigger: 'stop_api_done',
      hasEndMarker: false,
      fromUiStopButton: false,
      skipDedupe: true,
      detail: {
        whoZh: '停止 API 已返回（chatAbort / execution/stop）',
        note: '后端 stop 调用完成；页面齿轮可能仍亮，继续看 ui_idle_after_stop',
        sinceStopMs: streamStopSinceMs({ sessionKey: sk }) ?? undefined,
      },
    })

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
    logStreamStop({
      sessionKey: sk,
      runId: stopRunIdAtStop,
      trigger: 'stop_runtime_idle',
      hasEndMarker: false,
      fromUiStopButton: false,
      skipDedupe: true,
      detail: {
        whoZh: '前端 runtime 已置 idle（finishSessionRunIdle）',
        note: '本地 run 状态已清；若齿轮仍亮，多半是 V4 timelineBusy 未收口',
        sinceStopMs: streamStopSinceMs({ sessionKey: sk }) ?? undefined,
        foreground: isForeground,
      },
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
