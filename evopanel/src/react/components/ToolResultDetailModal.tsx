import { memo, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchToolResultFull, formatToolResultByteLabel } from '../../lib/tool-result-fetch.js'
import { formatToolOutputForUserDisplay } from '../../lib/chat-normalize.js'
import { stripToolOutputForDisplay } from '../../lib/strip-mind-map-hint.js'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'

export type ToolResultMetaBlock = {
  title: string
  value: string
}

type Props = {
  open: boolean
  title: string
  sessionKey?: string
  toolCallId: string
  tool: Record<string, unknown>
  metaBlocks: ToolResultMetaBlock[]
  contentTitle?: string
  onClose: () => void
}

function toolOutputByteCount(tool: Record<string, unknown>): number {
  const n = Number(tool.outputBytes ?? tool.output_bytes ?? tool.content_bytes ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function inlineToolOutputText(tool: Record<string, unknown>): string {
  const toolName = String(tool.name ?? tool.tool_name ?? tool.toolName ?? '').trim()
  return stripToolOutputForDisplay(formatToolOutputForUserDisplay(tool.output ?? tool.result, toolName))
}

function ToolResultDetailModalInner({
  open,
  title,
  sessionKey,
  toolCallId,
  tool,
  metaBlocks,
  contentTitle = '内容',
  onClose,
}: Props) {
  const byteCount = toolOutputByteCount(tool)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadContent = useCallback(async () => {
    if (loading) return
    const sk = String(sessionKey || '').trim()
    const tcid = String(toolCallId || '').trim()
    const inline = inlineToolOutputText(tool)
    if (!sk || !tcid) {
      setContent(inline)
      setError(inline ? null : '无法加载：缺少会话标识')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = (await fetchToolResultFull(sk, tcid)) as { content?: string }
      const fetched = String(data?.content ?? '')
      setContent(fetched || inline)
      if (!fetched && !inline) setError('无内容')
    } catch (e) {
      if (inline) {
        setContent(inline)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }, [loading, sessionKey, toolCallId, tool])

  useModalEscapeClose(onClose, { open })

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setContent(null)
        setError(null)
        setLoading(false)
      })
      return
    }
    queueMicrotask(() => void loadContent())
  }, [open, toolCallId, sessionKey])

  if (!open || typeof document === 'undefined') return null

  const display = loading && content == null ? '加载中…' : stripToolOutputForDisplay(content ?? '') || '无内容'

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card read-tool-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header">
          <span className="read-tool-detail-modal__title">{title}</span>
          <button type="button" className="react-chat-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="read-tool-detail-modal__body">
          {metaBlocks.map((block) => (
            <div key={block.title} className="msg-tool-block msg-tool-block--code">
              <div className="msg-tool-title">{block.title}</div>
              <pre>{block.value || '—'}</pre>
            </div>
          ))}
          <div className="msg-tool-block msg-tool-block--code read-tool-detail-modal__content">
            <div className="msg-tool-title">
              {contentTitle}
              {byteCount ? (
                <span className="read-tool-detail-modal__size">{formatToolResultByteLabel(byteCount)}</span>
              ) : null}
            </div>
            <pre>{display}</pre>
            {error ? (
              <>
                <pre className="msg-tool-load-full__error">{error}</pre>
                <button type="button" className="msg-tool-load-full" disabled={loading} onClick={() => void loadContent()}>
                  {loading ? '重试中…' : '重试加载'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const ToolResultDetailModal = memo(ToolResultDetailModalInner)

/** @deprecated use ToolResultDetailModal */
export const ReadToolDetailModal = ToolResultDetailModal
