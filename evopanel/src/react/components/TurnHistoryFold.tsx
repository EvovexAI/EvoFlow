import { memo, useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * ZCode 对齐：回合「已工作 X 分 X 秒」折叠头。
 * 流式期间 forceOpen：头部持续跳动 + 内容平铺展开（可手动收起）；
 * 回合结束后自动收拢为折叠头（默认关闭），展开后按 flat 时间线平铺。
 */
function TurnHistoryFoldInner({
  label,
  messageId,
  forceOpen = false,
  headerOnly = false,
  children,
}: {
  /** 如「已工作 5 分 22 秒」；空串时不渲染折叠（由调用方兜底平铺） */
  label: string
  /** 行 messageId，用于 data-testid（chat-assistant-history-trigger-{id}） */
  messageId?: string
  /** 流式中强制展开（用户手动收起可覆盖） */
  forceOpen?: boolean
  /** 仅渲染头部（流式首帧还没有工作条目时） */
  headerOnly?: boolean
  children?: ReactNode
}) {
  /** null = 未手动干预（跟随 forceOpen）；true/false = 用户手动展开/收起 */
  const [manual, setManual] = useState<boolean | null>(null)
  /** 收起动画期间保持 body 挂载，动画结束再真正隐藏 */
  const [closing, setClosing] = useState(false)
  const bodyId = useId()
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 190)
    return () => window.clearTimeout(t)
  }, [closing])
  if (!label) return <>{children}</>
  const expanded = manual ?? forceOpen
  const showBody = !headerOnly && (expanded || closing)
  const toggle = () => {
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
