/**
 * Session execution facade — 运行/停止的唯一对外层。
 */

export type {
  BackgroundStopContext,
  ForegroundStopContext,
  SessionExecutionRow,
  SessionRunEndedOpts,
  SessionRunEndedPatch,
  SessionStopHost,
  SessionTerminalRunStatus,
  StopSessionOptions,
} from './types.js'

export type { SessionExecutionProbe } from './probe-cache.js'

export {
  collectExecutingSessionKeys,
  isBackendRunActive,
  isSessionExecuting,
  isSessionGoalActive,
  isSessionSidebarExecuting,
  isSessionTurnPhaseBusy,
  isSessionWireActive,
} from './queries.js'

export {
  clearSessionExecutionStateForEnded,
  STOP_SEALED_SYSTEM_TEXT,
  abortSessionTurnEnded,
  beginSessionUserStop,
  completeStreamTurnEnded,
  createSessionRunEndedPatch,
  dispatchSessionRunEnded,
  finalizeSessionTurnEnded,
  finishSessionRunIdle,
  patchSessionListRunEnded,
  resolveTerminalRunStatus,
} from './commands.js'

export {
  clearSessionGoalRunning,
  collectGoalRunningSessionKeys,
  getSessionGoalStateEpoch,
  isSessionGoalRunning,
  markSessionGoalRunning,
  subscribeSessionGoalState,
} from './goal-mode-state.js'

export {
  clearSessionExecutionProbe,
  fetchAndCacheSessionExecutionState,
  getSessionExecutionProbe,
  getSessionExecutionProbeEpoch,
  refreshBackgroundExecutionProbes,
  setSessionExecutionProbe,
  subscribeSessionExecutionProbes,
} from './probe-cache.js'

export { sealSessionPartialTurnOnStop } from './seal-partial-turn.js'

export { stopSessionExecution } from './stop-session.js'
