import { useMemo, useSyncExternalStore } from 'react'
import {
  getExecutingListRuntimeEpoch,
  subscribeExecutingListRuntime,
} from '../lib/session-runtime-store.js'
import {
  getSessionExecutionProbeEpoch,
  subscribeSessionExecutionProbes,
} from '../lib/session-execution/probe-cache.js'
import {
  getSessionGoalStateEpoch,
  subscribeSessionGoalState,
} from '../lib/session-execution/goal-mode-state.js'
import {
  isSessionExecuting,
  isSessionGoalActive,
  isSessionTurnPhaseBusy,
  isSessionWireActive,
  type SessionExecutionRow,
} from '../lib/session-execution/index.js'

export type SessionExecutionView = {
  executing: boolean
  wireActive: boolean
  turnPhaseBusy: boolean
  goalActive: boolean
}

/**
 * executing 布尔值只跟 turn 起停有关，订 executing-list（非 per-delta runtime epoch），
 * 避免 ChatApp 在 SSE 文本/工具流期间整页 200ms 一刷。
 */
function useSessionExecutionEpoch(): number {
  const executingEpoch = useSyncExternalStore(
    subscribeExecutingListRuntime,
    getExecutingListRuntimeEpoch,
  )
  const probeEpoch = useSyncExternalStore(subscribeSessionExecutionProbes, getSessionExecutionProbeEpoch)
  const goalEpoch = useSyncExternalStore(subscribeSessionGoalState, getSessionGoalStateEpoch)
  return executingEpoch + probeEpoch + goalEpoch
}

export function useSessionExecutionState(
  sessionKey: string | null | undefined,
  sessionRow?: SessionExecutionRow | null,
): SessionExecutionView {
  const epoch = useSessionExecutionEpoch()
  return useMemo(() => {
    const goalActive = isSessionGoalActive(sessionKey)
    return {
      executing: isSessionExecuting(sessionKey, { sessionRow }),
      wireActive: isSessionWireActive(sessionKey),
      turnPhaseBusy: isSessionTurnPhaseBusy(sessionKey),
      goalActive,
    }
  }, [sessionKey, sessionRow, epoch])
}
