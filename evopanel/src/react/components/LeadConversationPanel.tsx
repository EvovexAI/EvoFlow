import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { renderMarkdown } from '../../lib/markdown.js'
import { resolveHistoryMessageContent } from '../../lib/chat-normalize.js'

type LeadMessage = {
  role: string
  content: string
  timestamp?: string | number
}

function normalizeLeadMessages(rawMessages: unknown[]): LeadMessage[] {
  return (Array.isArray(rawMessages) ? rawMessages : [])
    .map((msg: any) => {
      let content = resolveHistoryMessageContent(msg) ?? ''
      if (Array.isArray(content)) {
        content = content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text)
          .join('')
      }
      const role = msg?.role || (msg?.type === 'human' ? 'user' : msg?.type === 'ai' ? 'assistant' : 'unknown')
      return {
        role: String(role),
        content: String(content || ''),
        timestamp: msg?.timestamp,
      }
    })
    .filter((msg) => {
      const role = msg.role
      if (role === 'tool' || role === 'toolResult') return false
      const rawText = String(msg.content || '').trimStart()
      if (
        rawText.startsWith('[CONTEXT COMPACTION') ||
        rawText.startsWith('[上下文摘要') ||
        rawText.startsWith('[深度压缩摘要') ||
        rawText.startsWith('[tool:history]')
      ) {
        return false
      }
      return !!String(msg.content || '').trim()
    })
}

export type LeadConversationPanelProps = {
  threadId: string | null
  refreshKey?: number
  /** 工作流页：允许折叠以腾出 DAG 空间 */
  collapsible?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function LeadConversationPanel({
  threadId,
  refreshKey = 0,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
}: LeadConversationPanelProps) {
  const [messages, setMessages] = useState<LeadMessage[]>([])
  const [loading, setLoading] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const tid = String(threadId || '').trim()
    if (!tid) {
      setMessages([])
      return
    }
    setLoading(true)
    try {
      const payload = await api.chatMessagesByThread(tid, 150)
      if (!aliveRef.current) return
      const raw = Array.isArray(payload?.messages) ? payload.messages : []
      setMessages(normalizeLeadMessages(raw))
    } catch {
      if (aliveRef.current) setMessages([])
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load, refreshKey])

  const html = useMemo(
    () =>
      messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        const roleLabel = isUser ? '👤 用户' : '🧭 主控'
        const roleClass = isUser ? 'user-message' : 'ai-message lead-message'
        let timeStr = ''
        if (msg.timestamp) {
          try {
            const date = new Date(msg.timestamp)
            if (!Number.isNaN(date.getTime())) {
              timeStr = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            }
          } catch {
            // ignore
          }
        }
        const contentHtml = msg.content ? renderMarkdown(msg.content) : ''
        return (
          <div key={`${i}-${msg.role}`} className={`conversation-message ${roleClass}`}>
            <div className="message-header">
              <span className="message-role">{roleLabel}</span>
              {timeStr ? <span className="message-time">{timeStr}</span> : null}
            </div>
            {contentHtml ? (
              <div className="message-content markdown-body" dangerouslySetInnerHTML={{ __html: contentHtml }} />
            ) : null}
          </div>
        )
      }),
    [messages],
  )

  if (collapsible && collapsed) {
    return (
      <aside className="lead-conversation-panel lead-conversation-panel--collapsed" aria-label="主控对话">
        <button
          type="button"
          className="lead-conversation-panel-rail-btn"
          title="展开主控对话"
          aria-label="展开主控对话"
          onClick={() => onToggleCollapse?.()}
        >
          💬
        </button>
      </aside>
    )
  }

  return (
    <aside className="lead-conversation-panel" aria-label="主控对话">
      <header className="lead-conversation-panel-header">
        <span className="lead-conversation-panel-title">💬 主控对话</span>
        <div className="lead-conversation-panel-header-actions">
          {loading ? <span className="lead-conversation-panel-hint">加载中…</span> : null}
          {collapsible ? (
            <button
              type="button"
              className="lead-conversation-panel-collapse-btn"
              title="收起主控对话"
              aria-label="收起主控对话"
              onClick={() => onToggleCollapse?.()}
            >
              ‹
            </button>
          ) : null}
        </div>
      </header>
      <div className="lead-conversation-panel-body">
        {!threadId ? (
          <p className="lead-conversation-panel-empty">任务未绑定会话线程</p>
        ) : messages.length === 0 && !loading ? (
          <p className="lead-conversation-panel-empty">暂无对话记录<br />主控 Agent 执行后将显示对话</p>
        ) : (
          <div className="lead-conversation-messages">{html}</div>
        )}
      </div>
    </aside>
  )
}
