/**
 * H1 demo: minimal projection reducer for v4 frames.
 *
 * 单原子 store 形态（同 ZCode v4/ConversationProjectionStore 思想）：
 * - status: 'connecting' | 'live' | 'error' | 'closed'
 * - snapshot: 由 rows 数组 + seq 组成的最新投影
 * - listener 集合 + getState
 *
 * 收到 snapshot 整块替换；收到 deltas 逐项应用到 rows。
 */

import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from './protocol'

export type ProjectionStatus = 'connecting' | 'live' | 'error' | 'closed'

export interface ProjectionSnapshot {
  sessionId: string
  logEpoch: string
  seq: number
  rows: ConversationRow[]
}

export interface ProjectionState {
  status: ProjectionStatus
  snapshot: ProjectionSnapshot | null
  lastError: string | null
}

const INITIAL_STATE: ProjectionState = {
  status: 'connecting',
  snapshot: null,
  lastError: null,
}

type Listener = () => void

export class ConversationProjectionStore {
  private state: ProjectionState = INITIAL_STATE
  private readonly listeners = new Set<Listener>()

  getState = (): ProjectionState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(s: ProjectionState): void {
    this.state = s
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * 处理一帧。
   * - 整块 snapshot 整对象替换
   * - deltas 单调 apply；fromSeq mismatch -> 拒绝（不缓存猜测）+ 标 error
   */
  handleFrame(frame: ConversationTopicFrame): void {
    const payload = frame.payload
    if (payload.kind === 'conversationSnapshot') {
      this.applySnapshot(payload)
    } else if (payload.kind === 'conversationDeltas') {
      this.applyDeltas(frame.fromSeq, frame.toSeq, payload.deltas)
    }
  }

  private applySnapshot(snap: ConversationSnapshot): void {
    const rows = [...snap.rows.window].sort((a, b) => a.rowId - b.rowId)
    this.setState({
      status: 'live',
      snapshot: {
        sessionId: snap.sessionId,
        logEpoch: snap.logEpoch,
        seq: snap.seq,
        rows,
      },
      lastError: null,
    })
  }

  private applyDeltas(
    fromSeq: number,
    toSeq: number,
    deltas: ConversationDelta[],
  ): void {
    const cur = this.state.snapshot
    if (!cur) {
      // 没有 base snapshot；deltas 不能 apply
      this.setState({
        ...this.state,
        status: 'error',
        lastError: 'received deltas without snapshot',
      })
      return
    }
    if (fromSeq !== cur.seq) {
      this.setState({
        ...this.state,
        status: 'error',
        lastError: `seq mismatch: fromSeq=${fromSeq} state.seq=${cur.seq}`,
      })
      return
    }
    const nextRows = [...cur.rows]
    for (const d of deltas) {
      switch (d.op) {
        case 'row.appended':
        case 'row.upserted': {
          const idx = nextRows.findIndex((r) => r.rowId === d.row.rowId)
          if (idx === -1) {
            nextRows.push(d.row)
          } else {
            nextRows[idx] = d.row
          }
          break
        }
        case 'row.removed': {
          const idx = nextRows.findIndex((r) => r.rowId === d.fromRowId)
          if (idx !== -1) {
            nextRows.splice(idx, 1)
          }
          break
        }
      }
    }
    nextRows.sort((a, b) => a.rowId - b.rowId)
    this.setState({
      status: 'live',
      snapshot: {
        sessionId: cur.sessionId,
        logEpoch: cur.logEpoch,
        seq: toSeq,
        rows: nextRows,
      },
      lastError: null,
    })
  }

  close(): void {
    this.setState({ ...this.state, status: 'closed' })
  }
}