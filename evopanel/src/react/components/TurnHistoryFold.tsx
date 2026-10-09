import { memo, useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * 回合「工作中 / 已工作 / ⏹ 已停止」折叠面板。
 *
 * v4 设计：单层折叠，包裹整个回合（工具/思考/正文 + 文件变更 + 产物）。
 * - 工作中（isStreaming）默认展开 —— 用户实时看完整轨迹。
 * - 已工作 / 已停止（!isStreaming）默认收起 —— 只看头部状态条。
 * - 任何状态都可手动展开/收起，manual 状态在组件内持久化。
 * - 头部为 disabled 模式（headerOnly=true）时整个面板退化为状态条，不展开。
 */
function TurnHistoryFoldInner({
  label,
  messageId,
  headerOnly = false,
  defaultOpen = false,
  children,
}: {
  /** 如「工作中 1m23s」；空串时不渲染折叠（由调用方兜底平铺） */
  label: string
  /** 行 messageId，用于 data-testid（chat-assistant-history-trigger-{id}） */
  messageId?: string
  /** 仅渲染头部（折叠面板退化为静态状态条） */
  headerOnly?: boolean
  /** 初始展开态（手动展开/收起可覆盖） */
  defaultOpen?: boolean
  children?: ReactNode
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const [closing, setClosing] = useState(false)
  const bodyId = useId()
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 190)
    return () => window.clearTimeout(t)
  }, [closing])
  if (!label) return <>{children}</>
  // 展开优先级: 手动 > defaultOpen。manual=null 跟随 defaultOpen。
  const expanded = manual === true || (manual === null && defaultOpen)
  const showBody = !headerOnly && (expanded || closing)
  const toggle = () => {
    if (headerOnly) return
    if (expanded) {
      setManual(false)
      setClosing(true)
    } else {
      setManual(true)
      setClosing(false)
    }
  }
  return (
    <div className="msg-turn-history-fold">
      <div className="msg-turn-history-fold-head">
        <button
          type="button"
          className="msg-turn-history-fold-trigger"
          data-testid={messageId ? `chat-assistant-history-trigger-${messageId}` : undefined}
          data-history-open={expanded}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggle}
          disabled={headerOnly}
        >
          <span className="msg-turn-history-fold-label">{label}</span>
          <ChevronRight
            className={`msg-turn-history-fold-chevron${expanded ? ' is-open' : ''}`}
            size={16}
            strokeWidth={1.5}
            aria-hidden
          />
        </button>
      </div>
      {showBody ? (
        <div
          id={bodyId}
          className={`msg-turn-history-fold-body${closing ? ' is-closing' : ''}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export const TurnHistoryFold = memo(TurnHistoryFoldInner)
