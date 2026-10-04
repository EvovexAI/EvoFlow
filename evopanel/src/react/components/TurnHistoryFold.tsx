import { memo, useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * ZCode 对齐：回合完成态的「已工作 X 分 X 秒」折叠头。
 * 流式期间平铺；回合结束后整轮活动（思考/工具/旁白）收进此折叠，默认收起，
 * 展开后按 flat 时间线平铺。头部弱化灰 + 悬停箭头，展开时箭头旋转 90°。
 */
function TurnHistoryFoldInner({
  label,
  messageId,
  children,
}: {
  /** 如「已工作 5 分 22 秒」；空串时不渲染折叠（由调用方兜底平铺） */
  label: string
  /** 行 messageId，用于 data-testid（chat-assistant-history-trigger-{id}） */
  messageId?: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  /** 收起动画期间保持 body 挂载，动画结束再真正隐藏 */
  const [closing, setClosing] = useState(false)
  const bodyId = useId()
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 190)
    return () => window.clearTimeout(t)
  }, [closing])
  if (!label) return <>{children}</>
  const showBody = expanded || closing
  const toggle = () => {
    if (expanded) {
      setExpanded(false)
      setClosing(true)
    } else {
      setExpanded(true)
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
