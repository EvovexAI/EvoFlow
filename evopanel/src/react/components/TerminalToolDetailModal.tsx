import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchToolResultFull } from '../../lib/tool-result-fetch.js'
import { stripMindMapHint } from '../../lib/strip-mind-map-hint.js'
import type { TerminalStreamTask } from '../chat-types.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { TerminalToolPanel } from './TerminalToolPanel.js'

type Props = {
  open: boolean
  title: string
  command: string
  sessionKey?: string
  toolCallId?: string
  outputFallback?: string
  stream?: TerminalStreamTask
  running?: boolean
  onClose: () => void
}

function streamHasOutput(stream: TerminalStreamTask | undefined): boolean {
  if (!stream) return false
  if (stream.chunks?.length) {
    return stream.chunks.some((c) => String(c.text || '').length > 0)
  }
  return Boolean(String(stream.stdout || '').trim() || String(stream.stderr || '').trim())
}

/**
 * 终端 / 进程工具详情弹窗：
 *   - 行内只显示命令一行摘要，点击此弹窗才看完整输出
 *   - 打开弹窗即请求 tool-results（流式中已完成的调用也可查；运行中仍优先 terminalStreams 实时输出）
 */
function TerminalToolDetailModalInner({
  open,
  title,
  command,
  sessionKey,
  toolCallId,
  outputFallback,
  stream,
  running,
  onClose,
}: Props) {
  const [fetchedOutput, setFetchedOutput] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useModalEscapeClose(onClose, { open })

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setFetchedOutput(null)
        setFetchError(null)
        setLoading(false)
      })
      return
    }

    const sk = String(sessionKey || '').trim()
    const tcid = String(toolCallId || '').trim()
    if (!sk || !tcid) return

    let cancelled = false
    queueMicrotask(() => {
      setLoading(true)
      setFetchError(null)
    })
    void fetchToolResultFull(sk, tcid)
      .then((data) => {
        if (cancelled) return
        setFetchedOutput(String((data as { content?: string })?.content ?? ''))
      })
      .catch((e) => {
        if (cancelled) return
        setFetchError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, sessionKey, toolCallId, running])

  const effectiveOutputFallback = useMemo(() => {
    const local = stripMindMapHint(String(outputFallback || ''))
    const fetched = stripMindMapHint(String(fetchedOutput || ''))
    if (fetched.trim()) return fetched
    return local
  }, [outputFallback, fetchedOutput])

  const showLoadingHint =
    loading && !streamHasOutput(stream) && !String(effectiveOutputFallback || '').trim()

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title || '终端输出'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card read-tool-detail-modal terminal-tool-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <span className="read-tool-detail-modal__title">{title || '终端输出'}</span>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="read-tool-detail-modal__body terminal-tool-detail-modal__body">
          {showLoadingHint ? (
            <div className="msg-tool-block msg-tool-block--read-preview">
              <span className="msg-tool-read-pending">加载完整输出…</span>
            </div>
          ) : null}
          <TerminalToolPanel
            command={command}
            outputFallback={effectiveOutputFallback}
            stream={stream}
            running={running}
          />
          {fetchError && !streamHasOutput(stream) && !String(effectiveOutputFallback || '').trim() ? (
            <pre className="msg-tool-load-full__error">{fetchError}</pre>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const TerminalToolDetailModal = memo(TerminalToolDetailModalInner)
