/**
 * 子代理 transcript 弹层：对话体走主聊同一套 V4（V4SessionPaneBridge）。
 * 旧 SubtaskModalMessageRow / messagesToSubtaskModalRows 已退役。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { fetchSubagentTaskTranscript } from '../../lib/fetch-subagent-transcript.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { V4SessionPaneBridge } from '../v4/V4SessionPaneBridge.js'

const POLL_MS = 2000
const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled', 'timed_out'])

function SubagentTranscriptModalInner({
  taskId,
  title,
  sessionKey,
  fallbackText,
  fallbackStatus,
  onClose,
}: {
  taskId: string
  title?: string
  sessionKey?: string
  fallbackText?: string
  fallbackTools?: unknown[]
  fallbackStatus?: string
  onClose: () => void
}) {
  const [status, setStatus] = useState(String(fallbackStatus || ''))
  const [threadId, setThreadId] = useState('')
  const [asideNote, setAsideNote] = useState('')
  const [loaded, setLoaded] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useModalEscapeClose(onClose, { open: true })

  const fetchOnce = useCallback(async () => {
    const data = await fetchSubagentTaskTranscript(taskId)
    setLoaded(true)
    const apiStatus = String(data?.status || fallbackStatus || '')
    setStatus(apiStatus)
    const tid = String(data?.thread_id || '').trim()
    if (tid) {
      setThreadId(tid)
      setAsideNote('')
      return
    }
    const body = String(fallbackText || data?.result || data?.error || '').trim()
    if (body) setAsideNote(body)
  }, [taskId, fallbackText, fallbackStatus])

  useEffect(() => {
    let disposed = false
    void fetchOnce()
    pollRef.current = setInterval(() => {
      if (disposed) return
      if (TERMINAL.has(status.toLowerCase()) && loaded && threadId) {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
        return
      }
      void fetchOnce()
    }, POLL_MS)
    return () => {
      disposed = true
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [fetchOnce, status, loaded, threadId])

  const running = !TERMINAL.has(status.toLowerCase())

  return (
    <div className="react-chat-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="react-chat-modal-card react-chat-subtask-modal-card flex h-[min(80vh,720px)] w-[min(92vw,880px)] flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={title || '子代理输出'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header react-chat-subtask-modal-header">
          <div className="react-chat-subtask-modal-header-main">
            <div className="react-chat-subtask-modal-title">{title || '子代理输出'}</div>
            <span className="text-ui-xs text-foreground-subtlest">
              {running ? '执行中' : status || '已完成'}
            </span>
          </div>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {threadId ? (
            <V4SessionPaneBridge
              sessionId={threadId}
              connecting={!loaded}
              sessionKey={sessionKey || undefined}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-ui-sm text-foreground-subtlest">
              <span>
                {!loaded
                  ? '正在解析子代理会话…'
                  : running
                    ? '执行中，等待会话 thread…'
                    : '暂无子代理会话 thread'}
              </span>
              {asideNote ? (
                <pre className="max-h-64 w-full max-w-lg overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-3 text-left text-foreground">
                  {asideNote}
                </pre>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const SubagentTranscriptModal = memo(SubagentTranscriptModalInner)
