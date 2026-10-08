/**
 * 从 streamRef 读「进程」面板所需的实时聚合态。
 *
 * 为什么不把 terminalStreams 复制成 React state：
 * streamRef.terminalStreams 有多处清理点（切会话 / 换任务 / 终态收束），
 * 另开一份 state 必然漏清、留下幽灵终端行。这里沿用 ChatMessageStreamPane 的
 * 既成模式：ref 为唯一真相源，按 session-runtime 通知重算快照。
 *
 * 注意：mergeTerminalStreamEvent / mergeSubagentStreamEvent 都是「原地改对象」，
 * map 本身的引用永不变化，所以这里每次都重建新 map，不能用引用比较去重。
 */

import { useEffect, useState, type MutableRefObject } from 'react'
import type { StreamState, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { subscribeStreamSnapshot } from './stream-snapshot-store.js'

export type LiveProcessSnapshot = {
  terminalStreams: Record<string, TerminalStreamTask>
  subagentTasks: Record<string, SubagentStreamTask>
}

const EMPTY: LiveProcessSnapshot = { terminalStreams: {}, subagentTasks: {} }

export function useLiveProcessSnapshot(
  streamRef: MutableRefObject<StreamState> | null | undefined,
  enabled: boolean,
  sessionKey?: string,
): LiveProcessSnapshot {
  const [snapshot, setSnapshot] = useState<LiveProcessSnapshot>(EMPTY)

  useEffect(() => {
    if (!enabled || !streamRef) return
    let cancelled = false
    const sk = String(sessionKey || '').trim()

    const read = () => {
      if (cancelled) return
      const S = streamRef.current
      // 重建而非透传：底层是原地 mutate，引用比较无法感知变化
      setSnapshot({
        terminalStreams: { ...(S?.terminalStreams || {}) },
        subagentTasks: { ...(S?.subagentTasks || {}) },
      })
    }

    read()
    // 旧 stream-chrome-tick 已删：改为订阅 stream-snapshot-store
    const unsubscribe = subscribeStreamSnapshot(sk, read)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [streamRef, enabled, sessionKey])

  return snapshot
}
