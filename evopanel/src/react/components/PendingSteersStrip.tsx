import { memo } from 'react'

export type PendingSteerItem = {
  id: string
  messageId: string
  text: string
}

type PendingSteersStripProps = {
  items: PendingSteerItem[]
  onCancelPendingSteer?: (messageId: string) => void
  onInterruptAndSendSteers?: () => void
}

/** Mid-turn ↑ steers: sits above the composer input box, visually separate from typing area. */
export const PendingSteersStrip = memo(function PendingSteersStrip({
  items,
  onCancelPendingSteer,
  onInterruptAndSendSteers,
}: PendingSteersStripProps) {
  if (!items.length) return null

  return (
    <div className="react-chat-steer-strip" aria-label="待注入纠偏">
      <div className="react-chat-steer-strip__header">
        <span className="react-chat-steer-strip__title">
          下次模型调用时提交
          {items.length > 1 ? `（${items.length}）` : ''}
        </span>
        <span className="react-chat-steer-strip__hint">Esc 打断并立即发送</span>
        {onInterruptAndSendSteers ? (
          <button
            type="button"
            className="react-chat-steer-strip__interrupt"
            title="打断当前回合并立即发送这些纠偏"
            onClick={() => onInterruptAndSendSteers()}
          >
            立即发送
          </button>
        ) : null}
      </div>
      <div className="react-chat-steer-strip__list">
        {items.map((item) => (
          <div key={item.messageId || item.id} className="react-chat-steer-strip__bubble">
            <span className="react-chat-steer-strip__bubble-label" aria-hidden="true">
              纠偏
            </span>
            <span className="react-chat-steer-strip__bubble-text" title={item.text}>
              {item.text}
            </span>
            {onCancelPendingSteer ? (
              <button
                type="button"
                className="react-chat-steer-strip__cancel"
                title="取消此条纠偏"
                aria-label="取消纠偏"
                onClick={() => onCancelPendingSteer(item.messageId)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
})
