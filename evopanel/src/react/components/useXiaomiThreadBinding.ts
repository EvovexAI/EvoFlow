/**
 * 小V 会话 → V4 thread 绑定（threadId + 工作区根）。
 *
 * 小V 对话有两处宿主（右栏小V标签页、语音全屏右上角回复区），
 * 两者必须订阅同一个 LangGraph thread，否则两处看到的不是同一轮对话。
 * 本 hook 只负责「把 sessionKey 解析成 threadId」，不碰渲染。
 */
import { useEffect, useState } from 'react'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import { wsClient } from '../../lib/ws-client.js'
import { readXiaomiWorkspacePath } from './xiaomiChatActions.js'

function readThreadId(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  return String(wsClient.getSessionThreadId?.(sk) || '').trim()
}

export type XiaomiThreadBinding = {
  /** LangGraph threadId；空串表示还没绑定（V4 会显示「连接中」）。 */
  threadId: string
  /** 工作区根（绝对路径）。 */
  workspacePath: string
  /** 本地 assistant-store 里的消息条数（判断是否还是空会话）。 */
  localMsgCount: number
}

export function useXiaomiThreadBinding(sessionKey: string): XiaomiThreadBinding {
  const sk = String(sessionKey || '').trim()
  const [threadId, setThreadId] = useState(() => readThreadId(sk))
  const [workspacePath, setWorkspacePath] = useState(() => readXiaomiWorkspacePath(sk))
  const [localMsgCount, setLocalMsgCount] = useState(() => {
    const s = getState()
    return Array.isArray(s.messages) ? s.messages.length : 0
  })

  useEffect(() => {
    let cancelled = false
    const syncMeta = () => {
      const s = getState()
      setLocalMsgCount(Array.isArray(s.messages) ? s.messages.length : 0)
      const next = readThreadId(sk)
      setThreadId((prev) => (prev === next ? prev : next))
      setWorkspacePath(readXiaomiWorkspacePath(sk))
    }
    syncMeta()
    // store 每次 patch 都会通知 → thread 落库后立刻能拿到，不必等轮询。
    const unsub = subscribe(syncMeta)

    const onRebound = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; threadId?: string }>).detail
      if (String(detail?.sessionKey || '').trim() !== sk) return
      const next = String(detail?.threadId || '').trim() || readThreadId(sk)
      if (next) setThreadId(next)
    }
    window.addEventListener('evopanel:session-thread-rebound', onRebound)

    // 打开时主动 resolve thread，避免仅靠轮询导致历史一直空白
    void (async () => {
      if (!sk) return
      try {
        const tid = String(
          (await wsClient.resolveSessionThreadId?.(sk)) || readThreadId(sk) || '',
        ).trim()
        if (!cancelled && tid) setThreadId(tid)
      } catch {
        /* ignore */
      }
    })()

    const needPoll = !readThreadId(sk)
    const poll = window.setInterval(() => {
      const next = readThreadId(sk)
      if (next) setThreadId((prev) => (prev === next ? prev : next))
    }, needPoll ? 400 : 2500)
    return () => {
      cancelled = true
      unsub?.()
      window.removeEventListener('evopanel:session-thread-rebound', onRebound)
      window.clearInterval(poll)
    }
  }, [sk])

  return { threadId, workspacePath, localMsgCount }
}
