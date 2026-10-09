import { memo, useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * 回合「已工作 X · Y tok / ⏹ 已停止 / 工作中 X · Y tok」折叠头。
 *
 * v2 设计：折叠 = 静态信息条。
 * - 头部永远显示，承载回合级状态（时长 / token / 打断）；
 * - body 默认收起，仅当用户点击 chevron 展开后才显示下方的工具/思考/旁白；
 * - 流式期间不再强制展开——"工作中" 也是默认收起（正文仍外露在折叠外），
 *   让用户主动决定是否点开看明细。
 *
 * manual 状态在组件内持久化，会话内手动展开过的回合在 remount 前都保持展开。
 */
function TurnHistoryFoldInner({
  label,
  messageId,
  headerOnly = false,
  children,
}: {
  /** 如「工作中 1m23s · 1,204 tok」；空串时不渲染折叠（由调用方兜底平铺） */
  label: string
  /** 行 messageId，用于 data-testid（chat-assistant-history-trigger-{id}） */
  messageId?: string
  /** 仅渲染头部（流式首帧还没有工作条目时） */
  headerOnly?: boolean
  children?: ReactNode
}) {
  /** null = 跟随默认（收起）；true/false = 用户手动展开/收起 */
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
  const expanded = manual === true
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
