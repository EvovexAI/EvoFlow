import { useEffect, useRef, useState } from 'react'
import { fetchCollabWorkflowFromApi } from '../../lib/collab-subtasks-from-api.js'
import type { CollabSubtaskSnapshot, CollabTaskSnapshot } from '../chat-types.js'

export type UseCollabSubtasksFromApiOpts = {
  taskId: string | null
  threadId: string | null
  sessionKey?: string | null
  /** 为 false 时不请求、并清空缓存态 */
  enabled: boolean
  /** 父级 bump 或弹窗打开等导致需 bypass 短缓存 */
  refreshKey?: number | string
  /** 切换会话后丢弃 in-flight 结果 */
  isStillActive?: () => boolean
}

export type CollabWorkflowFromApi = {
  subtasks: CollabSubtaskSnapshot[] | null
  mainTask: CollabTaskSnapshot | null
}

/**
 * Sidebar / CollabExecutionPanel 共用：同一主任务只拉一次 GET /tasks（主任务 + subtasks，均以存储为准）。
 */
export function useCollabSubtasksFromApi(opts: UseCollabSubtasksFromApiOpts): CollabWorkflowFromApi {
  const { taskId, threadId, sessionKey, enabled, refreshKey = 0, isStillActive } = opts
  const [bundle, setBundle] = useState<CollabWorkflowFromApi>({ subtasks: null, mainTask: null })
  const lastSigRef = useRef('')
  const isStillActiveRef = useRef(isStillActive)

  useEffect(() => {
    isStillActiveRef.current = isStillActive
  })

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
    const sig = `${tid}:${tidThread}:${sk}:${refreshKey}`
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
  }, [enabled, taskId, threadId, sessionKey, refreshKey])

  return bundle
}
