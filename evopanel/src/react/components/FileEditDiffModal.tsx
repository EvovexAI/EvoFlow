import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchFileEditPayloadForToolCall } from '../lib/file-edit-tool-fetch.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { FileEditDiffPanel } from './FileEditDiffPanel.js'

export type FileEditDiffModalPayload = {
  toolCallId?: string
  title: string
  path: string
  action: string
  instruction?: string
  content?: string
  old_string?: string
  new_string?: string
  before_content?: string
  after_content?: string
  running?: boolean
  ok?: boolean
  result?: string
  /** progress phase: 'args' | 'writing' | 'done' | 'error' */
  phase?: string
  /** total bytes to write (when known) */
  bytes_total?: number
  /** bytes written so far */
  bytes_written?: number
  /** lines added */
  lines_added?: number
  /** lines removed */
  lines_removed?: number
  /** status message from backend */
  message?: string
  /** accumulated arg content length (args phase streaming progress) */
  content_len?: number
}

type Props = {
  open: boolean
  sessionKey?: string
  payload: FileEditDiffModalPayload | null
  onClose: () => void
}

function FileEditDiffModalInner({ open, sessionKey, payload, onClose }: Props) {
  const [resolved, setResolved] = useState<FileEditDiffModalPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !payload) {
      queueMicrotask(() => {
        setResolved(null)
        setError(null)
        setLoading(false)
      })
      return
    }
    let cancelled = false
    const tcid = String(payload.toolCallId || '').trim()
    const sk = String(sessionKey || '').trim()
    const streaming =
      Boolean(payload.running) ||
      payload.phase === 'args' ||
      payload.phase === 'writing'
    // During live write streaming, always mirror the latest payload — do not keep a
    // stale ``resolved`` snapshot that would freeze the first few tokens in the UI.
    if (!sk || !tcid || streaming) {
      queueMicrotask(() => {
        if (!cancelled) {
          setResolved(payload)
          setError(null)
          setLoading(false)
        }
      })
      return () => {
        cancelled = true
      }
    }
    // Switching to another tool call: drop previous resolved immediately so we never
    // flash file A's body under file B's title while the fetch is in flight.
    queueMicrotask(() => {
      if (!cancelled) {
        setResolved(payload)
        setLoading(true)
        setError(null)
      }
    })
    void fetchFileEditPayloadForToolCall(sk, tcid, payload)
      .then((next) => {
        if (!cancelled) setResolved(next)
      })
      .catch((e) => {
        if (!cancelled) {
          setResolved(payload)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    open,
    sessionKey,
    payload?.toolCallId,
    payload?.path,
    payload?.running,
    payload?.phase,
    payload?.content,
    payload?.old_string,
    payload?.new_string,
    payload?.content_len,
    payload?.message,
    payload?.ok,
    payload?.title,
    payload?.action,
    payload?.bytes_total,
    payload?.bytes_written,
    payload?.lines_added,
    payload?.lines_removed,
  ])

  useModalEscapeClose(onClose, { open })

  if (!open || !payload || typeof document === 'undefined') return null

  const streaming =
    Boolean(payload.running) || payload.phase === 'args' || payload.phase === 'writing'
  // Prefer live payload while streaming. For completed tools, only use resolved when it
  // belongs to the same toolCallId — otherwise multi-file opens show the first file's body.
  const resolvedMatches =
    resolved &&
    String(resolved.toolCallId || '').trim() === String(payload.toolCallId || '').trim()
  const view = streaming ? payload : resolvedMatches ? resolved : payload

  const progressLabel =
    view.phase === 'error'
      ? /String not found/i.test(String(view.message || ''))
        ? '写入错误：未找到匹配文本'
        : /File not found/i.test(String(view.message || ''))
          ? '写入错误：文件不存在'
          : /appears \d+ times/i.test(String(view.message || ''))
            ? '写入错误：匹配不唯一'
            : '写入错误'
      : view.phase === 'done'
        ? '写入完成'
        : view.phase === 'writing'
          ? '写入中'
          : view.phase === 'args'
            ? '生成中'
            : view.running
              ? '处理中'
              : ''
  const progressTitle =
    view.phase === 'error' && view.message ? String(view.message) : progressLabel
  const showStatus =
    Boolean(progressLabel) &&
    (view.running || view.phase === 'args' || view.phase === 'writing' || view.phase === 'error')

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={view.title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card file-edit-diff-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <span className="read-tool-detail-modal__title" title={view.path}>
            {view.title}
          </span>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        {showStatus ? (
          <div className="file-edit-modal-progress file-edit-modal-progress--text" title={progressTitle}>
            <span className="file-edit-modal-progress-label">{progressLabel}</span>
          </div>
        ) : null}
        <div className="file-edit-diff-modal__body react-msg-tool">
          {loading && !resolved ? (
            <p className="file-edit-diff-modal__loading">加载工具请求…</p>
          ) : null}
          {error ? (
            <p className="file-edit-diff-modal__error" title={error}>
              无法从服务端加载完整参数，已显示本地快照。
            </p>
          ) : null}
          <FileEditDiffPanel
            path={view.path}
            action={view.action}
            instruction={view.instruction}
            content={view.content}
            old_string={view.old_string}
            new_string={view.new_string}
            before_content={view.before_content}
            after_content={view.after_content}
            running={view.running}
            ok={view.ok}
            result={view.result}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const FileEditDiffModal = memo(FileEditDiffModalInner)
