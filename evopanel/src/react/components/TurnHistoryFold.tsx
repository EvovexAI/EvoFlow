import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
  /**
   * v5.3：body 永远在 DOM（折叠时也不卸载 children）。
   * 用于「已工作默认折叠时，最新轮 piece 仍要外露」场景 — 由 children 自身用 CSS
   * 决定哪些 piece 可见（latest 永远在，history 折叠时 display:none）。
   * 关闭时（默认 false）保持 v5 行为：折叠时 body 整个不渲染。
   */
  bodyAlwaysRendered = false,
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
  bodyAlwaysRendered?: boolean
  children?: ReactNode
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const [closing, setClosing] = useState(false)
  const bodyId = useId()
  // v5.6：auto-open 粘滞。回合在本会话流式期间展开过（defaultOpen=true），完成后
  // defaultOpen 翻 false（含 isStreaming 抖动）时不得自动收起——已实时显示过的
  // 工具/思考轨迹一旦消失就是用户报告的「工具显示一次就没了」。仅用户手动收起
  // （manual=false）才进入 v5.5 折叠态（CSS 只露最新正文）。DB 历史行 defaultOpen
  // 从未为 true，仍默认折叠。
  const lastAutoOpenRef = useRef(defaultOpen)
  if (defaultOpen) lastAutoOpenRef.current = true
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 190)
    return () => window.clearTimeout(t)
  }, [closing])
  if (!label) return <>{children}</>
  // 展开优先级: 手动 > 粘滞 defaultOpen。manual=null 跟随 defaultOpen。
  const expanded =
    manual === true || (manual === null && (defaultOpen || lastAutoOpenRef.current))

  // 【调试】追踪折叠状态
  const prevExpandedRef = useRef<boolean | null>(null)
  useEffect(() => {
    const prev = prevExpandedRef.current
    const now = new Date().toISOString()
    console.log(
      `[GearDebug] TurnHistoryFold expanded: ${prev} → ${expanded}`,
      '| label:', label,
      '| defaultOpen:', defaultOpen,
      '| manual:', manual,
      '| lastAutoOpenRef:', lastAutoOpenRef.current,
      '| timestamp:', now,
    )
    prevExpandedRef.current = expanded
  }, [expanded, label, defaultOpen, manual])
  // v5.3：bodyAlwaysRendered=true 时，body 永远渲染，children 自身用 CSS 决定可见性。
  const showBody = (!headerOnly && (expanded || closing)) || bodyAlwaysRendered
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
    <div className="msg-turn-history-fold" data-history-open={expanded}>
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
          {/* headerOnly（独立状态条）模式：完全隐藏 chevron，只显文字。
              折叠模式下保留 chevron 让用户能展开/收起。 */}
          {headerOnly ? null : (
            <ChevronRight
              className={`msg-turn-history-fold-chevron${expanded ? ' is-open' : ''}`}
              size={16}
              strokeWidth={1.5}
              aria-hidden
            />
          )}
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
