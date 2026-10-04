import { memo } from 'react'
import { HoverBubble } from './HoverBubble.js'

export type TurnNavigatorTurn = {
  /** 对应 historyItems 的行下标（跳转锚点） */
  rowIndex: number
  /** 悬停预览：该条问题的文本摘要 */
  preview: string
}

/**
 * ZCode 对齐：回合导航条（v4 ConversationTurnNavigator 同构）。
 * 左缘垂直居中的问题刻度轨，≥2 条问题才显示（<864px 宽由 CSS 隐藏）；
 * 点击平滑跳到对应用户问题行；当前回合刻度为深色，悬停放大并弹预览。
 */
function TurnNavigatorRailInner({
  turns,
  activeIndex,
  onJump,
}: {
  turns: TurnNavigatorTurn[]
  activeIndex: number
  onJump: (rowIndex: number) => void
}) {
  if (turns.length < 2) return null
  return (
    <nav className="msg-turn-navigator" aria-label="回合导航" data-item-count={turns.length}>
      <div className="msg-turn-navigator-rail">
        {turns.map((turn, index) => {
          const active = index === activeIndex
          return (
            <div key={`${turn.rowIndex}-${index}`} className="msg-turn-navigator-slot">
              <HoverBubble text={turn.preview} side="right" align="start" maxWidth={320}>
                <button
                  type="button"
                  className={`msg-turn-navigator-item${active ? ' is-active' : ''}`}
                  aria-label={`跳转到第 ${index + 1} 条问题`}
                  aria-current={active ? 'location' : undefined}
                  aria-posinset={index + 1}
                  aria-setsize={turns.length}
                  data-turn-row-index={turn.rowIndex}
                  data-active={active}
                  onClick={() => onJump(turn.rowIndex)}
                >
                  <span className="msg-turn-navigator-bar" aria-hidden />
                </button>
              </HoverBubble>
            </div>
          )
        })}
      </div>
    </nav>
  )
}

export const TurnNavigatorRail = memo(TurnNavigatorRailInner)
