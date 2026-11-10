/** 会话执行层对外类型 — UI / 侧栏 / 停止命令共用 */

export type SessionExecutionRow = {
  sessionKey?: string
  runStatus?: string | null
  currentRunId?: string | null
  currentTurnEndedAt?: string | null
}

/** DB 终态 run_status（与 backend session_run_state 对齐；不再写 idle） */
export type SessionTerminalRunStatus = 'done' | 'success' | 'fail' | 'cancelled' | 'stopped'

export type SessionRunEndedPatch = {
  runStatus: SessionTerminalRunStatus
  currentRunId: null
  currentTurnEndedAt: string
}

export type SessionRunEndedOpts = {
  endedAt?: string
  terminalStatus?: SessionTerminalRunStatus
  /** 与 terminalStatus 二选一：按 reason 解析终态 */
  reason?: string
  aborted?: boolean
  failed?: boolean
}

/**
 * 谁发起了 stopSessionExecution（前端日志主字段）。
 * 勿再统一标成 ui_stop_button——会把「打断重发」误读成「用户点了停止」。
 */
export type SessionStopSource =
  | 'composer_stop_button'
  | 'shell_sidebar_stop'
  | 'v4_stop_button'
  | 'v4_escape'
  | 'interrupt_send_steers'
  | 'interrupt_flush_queue'
  | 'page_load_stale_stop'
  | 'employee_process_pane'
  | 'unknown'

export type StopSessionOptions = {
  showToast?: boolean
  /** 停止来源；缺省 unknown（日志会标明未标注） */
  source?: SessionStopSource
}

/** ChatApp 等宿主注入的 UI / 副作用（网络与 runtime 状态由 session-execution 统一编排） */
export type SessionStopHost = {
  isForegroundSession: (sessionKey: string) => boolean
  onUserStopStarted?: () => void
  onUserStopFinished?: () => void
  onForegroundStopComplete: (ctx: ForegroundStopContext) => void
  onBackgroundStopComplete?: (ctx: BackgroundStopContext) => void
  onRefreshSessions?: () => void | Promise<void>
  onReloadHistory?: (sessionKey: string) => void | Promise<void>
  onScheduleRuntimeBump?: () => void
  deleteLiveRunSnapshot?: (sessionKey: string) => void
  /** 乐观将会话行 run_status 置终态（宿主内 patch React state / store） */
  onSessionRunEnded?: (sessionKey: string, opts?: Pick<SessionRunEndedOpts, 'terminalStatus' | 'reason'>) => void
  toast?: (message: string, kind: 'info' | 'error' | 'success') => void
}

export type ForegroundStopContext = {
  sessionKey: string
  stopRunId: string | null
}

export type BackgroundStopContext = {
  sessionKey: string
  stopRunId: string | null
}
