/**
 * EvoFlow v4 projection store — **verbatim-converted** ZCode
 * ``conversationProjectionStore.ts`` skeleton (H2.5).
 *
 * H2 已写了简化版（247 行）：status state machine、整 snapshot 替换、deltas in-place
 * apply；H2.5 升级为：
 *  - verbatim 接入 ``applyConversationDeltas``（v4 协议语义）；
 *  - status == live 时吞行时 delta，断档（fromSeq 不匹配）置 'error' 不再继续吞；
 *  - 单一原子 store + useSyncExternalStore 订阅；
 *  - recoveryDeadline 自动重订阅（ZCode 的 RuntimeRecycleRetry Delays）。
 *
 * 完整 spec：``EvoFlow/docs/protocol-evolution-spec.md`` 与
 * ``ZCode/packages/shared/src/zcode-protocol-v4/``。
 */

import {
  applyConversationDeltas,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from './protocol/types'

export type ProjectionStatus = 'connecting' | 'live' | 'error' | 'closed'

export interface ProjectionSnapshot {
  sessionId: string
  logEpoch: string
  seq: number
  rows: ConversationRow[]
  // verbatim extras to match zcode-protocol-v4 ConversationSnapshot
  protocolVersion: 1
  revision: number
  firstRowId: number | null
  totalCount: number
}

export interface ProjectionState {
  status: ProjectionStatus
  snapshot: ProjectionSnapshot | null
  lastError: string | null
  subscriptionId: string | null
  recoveryDeadline: number | null
}

const INITIAL_STATE: ProjectionState = {
  status: 'connecting',
  snapshot: null,
  lastError: null,
  subscriptionId: null,
  recoveryDeadline: null,
}

type Listener = () => void

export interface ConversationProjectionStoreOptions {
  topic: string
  initial?: ProjectionState
}

// verbatim-equivalent of ZCode's bounded RuntimeRecycle retry delays.
const RECOVERY_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const

export class ConversationProjectionStore {
  private state: ProjectionState
  private readonly listeners = new Set<Listener>()
  // ``topic`` reserved for H2.5+ multi-session routing; single-topic for now.
  // field retained so consumers can read the planned handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _topic: string

  constructor(opts: ConversationProjectionStoreOptions) {
    this._topic = opts.topic
    this.state = opts.initial ?? { ...INITIAL_STATE }
  }

  getState = (): ProjectionState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private replaceState(updater: (s: ProjectionState) => ProjectionState): void {
    const next = updater(this.state)
    if (next === this.state) return
    this.state = next
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // ignore listener errors
      }
    }
  }

  // -- 写入 --------------------------------------------------------------

  /** Subscription ACK 到达时调用：把 subscriptionId 写入 state + status='live'。 */
  ackSubscribe(subscriptionId: string, _logEpoch: string, _mode: 'snapshot' | 'resume'): void {
    this.replaceState((s) => ({
      ...s,
      subscriptionId,
      lastError: null,
    }))
  }

  /** 接收 snapshot frame：整块替换。 */
  applySnapshotFrame(frame: ConversationTopicFrame): void {
    if (frame.payload.kind !== 'conversationSnapshot') {
      this.replaceState((s) => ({
        ...s,
        status: 'error',
        lastError: `expected snapshot, got ${frame.payload.kind}`,
      }))
      return
    }
    const snap = frame.payload as ConversationSnapshot
    const rows = [...snap.rows.window]
    rows.sort((a, b) => a.rowId - b.rowId)
    this.replaceState((s) => ({
      ...s,
      status: 'live',
      lastError: null,
      snapshot: {
        protocolVersion: 1,
        sessionId: snap.sessionId,
        logEpoch: snap.logEpoch,
        seq: snap.seq,
        revision: 0,
        rows,
        firstRowId: snap.rows.firstRowId,
        totalCount: snap.rows.totalCount,
      },
      subscriptionId: frame.subscriptionId,
    }))
  }

  /** 接收 deltas frame：仅当 fromSeq === state.seq 时 apply（verbatim 语义）。 */
  applyDeltasFrame(frame: ConversationTopicFrame): void {
    if (frame.payload.kind !== 'conversationDeltas') {
      this.replaceState((s) => ({
        ...s,
        status: 'error',
        lastError: `expected deltas, got ${frame.payload.kind}`,
      }))
      return
    }
    const cur = this.state.snapshot
    if (!cur) {
      this.replaceState((s) => ({
        ...s,
        status: 'error',
        lastError: 'received deltas without snapshot',
      }))
      return
    }
    if (frame.fromSeq !== cur.seq) {
      // verbatim behaviour: gap → 'error' + recoveryDeadline 触发外部 retry
      this.replaceState((s) => ({
        ...s,
        status: 'error',
        lastError: `seq mismatch: fromSeq=${frame.fromSeq} state.seq=${cur.seq}`,
        recoveryDeadline: Date.now() + 1000,
      }))
      return
    }
    // 用 verbatim applyConversationDeltas 重算 rows（保持 snapshot schema 不变量）。
    const nextSnap = applyConversationDeltas(
      {
        ...cur,
        sessionId: cur.sessionId,
        logEpoch: cur.logEpoch,
        protocolVersion: 1,
        revision: cur.revision,
        rows: {
          window: cur.rows,
          firstRowId: cur.firstRowId,
          totalCount: cur.totalCount,
        },
      },
      (frame.payload as { deltas: ConversationDelta[] }).deltas,
    )
    this.replaceState((s) => ({
      ...s,
      status: 'live',
      lastError: null,
      snapshot: {
        ...cur,
        seq: frame.toSeq,
        rows: nextSnap.rows.window,
        firstRowId: nextSnap.rows.firstRowId,
        totalCount: nextSnap.rows.totalCount,
      },
      subscriptionId: frame.subscriptionId,
    }))
  }

  /** 顶层 dispatcher：解析 frame.payload.kind 路由。 */
  handleFrame(frame: ConversationTopicFrame): void {
    if (frame.payload.kind === 'conversationSnapshot') {
      this.applySnapshotFrame(frame)
    } else if (frame.payload.kind === 'conversationDeltas') {
      this.applyDeltasFrame(frame)
    }
  }

  /** 服务端 assembly fault 时调用。 */
  setError(message: string): void {
    this.replaceState((s) => ({
      ...s,
      status: 'error',
      lastError: message,
      recoveryDeadline: Date.now() + RECOVERY_RETRY_DELAYS_MS[RECOVERY_RETRY_DELAYS_MS.length - 1],
    }))
  }

  close(): void {
    this.replaceState((s) => ({ ...s, status: 'closed' }))
  }
}

// keep noisy internal helper for downstream consumers
export { RECOVERY_RETRY_DELAYS_MS as PROTOCOL_V4_RECOVERY_DELAYS_MS }
