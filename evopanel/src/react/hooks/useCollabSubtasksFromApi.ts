import { useEffect, useRef, useState } from 'react'
import { fetchCollabWorkflowFromApi } from '../../lib/collab-subtasks-from-api.js'
import { isTaskCancellableStatus } from '../../lib/task-status-label.js'
import type { CollabSubtaskSnapshot, CollabTaskSnapshot } from '../chat-types.js'

export type UseCollabSubtasksFromApiOpts = {
  taskId: string | null
  threadId: string | null
  sessionKey?: string | null
  /** 为 false 时不请求、并清空缓存态 */
  enabled: boolean
  /** 父级 bump 或弹窗打开等导致需 bypass 短缓存 */
  refreshKey?: number | string
  /**
   * 运行中心跳间隔（ms）。`platform ui.show` 打开的工作流不走会话侧 bump，
   * 必须在此自轮询，否则节点状态会一直停在首帧。
   */
  pollMs?: number
  /** 切换会话后丢弃 in-flight 结果 */
  isStillActive?: () => boolean
}

export type CollabWorkflowFromApi = {
  subtasks: CollabSubtaskSnapshot[] | null
  mainTask: CollabTaskSnapshot | null
}

function workflowLooksActive(bundle: CollabWorkflowFromApi): boolean {
  if (!bundle.mainTask && bundle.subtasks == null) return true
  if (bundle.mainTask && isTaskCancellableStatus(bundle.mainTask.status)) return true
  const subs = Array.isArray(bundle.subtasks) ? bundle.subtasks : []
  return subs.some((s) => s && isTaskCancellableStatus(s.status))
}

/**
 * Sidebar / CollabExecutionPanel 共用：GET /tasks（主任务 + subtasks，均以存储为准）。
 * 可选 pollMs：执行未终态时定期 bypass 缓存重拉。
 */
export function useCollabSubtasksFromApi(opts: UseCollabSubtasksFromApiOpts): CollabWorkflowFromApi {
  const { taskId, threadId, sessionKey, enabled, refreshKey = 0, pollMs = 0, isStillActive } = opts
  const [bundle, setBundle] = useState<CollabWorkflowFromApi>({ subtasks: null, mainTask: null })
  const [pollTick, setPollTick] = useState(0)
  const lastSigRef = useRef('')
  const isStillActiveRef = useRef(isStillActive)

  useEffect(() => {
    isStillActiveRef.current = isStillActive
  })

  const pollActive = enabled && (Number(pollMs) || 0) > 0 && workflowLooksActive(bundle)
  useEffect(() => {
    const ms = Number(pollMs) || 0
    if (!pollActive || ms <= 0) return
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setPollTick((n) => n + 1)
    }, ms)
    return () => window.clearInterval(interval)
  }, [pollActive, pollMs])

  useEffect(() => {
    if (!enabled) {
      lastSigRef.current = ''
      queueMicrotask(() => setBundle({ subtasks: null, mainTask: null }))
      return
    }
    const tid = String(taskId || '').trim()
    const tidThread = String(threadId || '').trim()
    const sk = String(sessionKey || '').trim()
    if (!tid && !tidThread && !sk) {
      lastSigRef.current = ''
      queueMicrotask(() => setBundle({ subtasks: null, mainTask: null }))
      return
    }
    const sig = `${tid}:${tidThread}:${sk}:${refreshKey}:${pollTick}`
    const bypassCache = lastSigRef.current !== sig
    lastSigRef.current = sig
    let cancelled = false
    void (async () => {
      try {
        const fetched = await fetchCollabWorkflowFromApi(tid, {
          ...(sk ? { sessionKey: sk, ...(tid ? { preferTaskId: tid } : {}) } : {}),
          ...(tidThread && !tidThread.startsWith('agent:')
            ? { threadId: tidThread, ...(tid ? { preferTaskId: tid } : {}) }
            : tid
              ? { preferTaskId: tid }
              : {}),
          bypassCache,
        })
        if (cancelled) return
        const stillActive = isStillActiveRef.current
        if (stillActive && !stillActive()) return
        setBundle({ subtasks: fetched.subtasks, mainTask: fetched.mainTask })
      } catch {
        if (!cancelled) {
          const stillActive = isStillActiveRef.current
          if (!stillActive || stillActive()) {
            setBundle({ subtasks: [], mainTask: null })
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, taskId, threadId, sessionKey, refreshKey, pollTick])

  return bundle
}