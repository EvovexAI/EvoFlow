import type { ReactNode } from 'react'
import { XiaomiV4Timeline } from './XiaomiV4Timeline.js'

/**
 * 小V 对话正文 = 主对话 / 侧栏员工同一套 V4（V4SessionPaneBridge → ConversationTimeline）。
 * 窄栏 embedded：隐藏 turn navigator；可挂 bottomDock（ChatComposer）。
 */
export function XiaomiChatThread({
  sessionKey = '',
  optimisticUserText = null,
  bottomDock,
  sessionBusy = false,
}: {
  sessionKey?: string
  optimisticUserText?: string | null
  bottomDock?: ReactNode
  /** 与停止按钮同源：驱动末轮工作中齿轮。 */
  sessionBusy?: boolean
}) {
  return (
    <div className="xm-react-thread xm-react-thread--v4" data-xm-chat-panel="v4">
      <XiaomiV4Timeline
        sessionKey={sessionKey}
        embedded
        optimisticUserText={optimisticUserText}
        bottomDock={bottomDock}
        sessionBusy={sessionBusy}
      />
    </div>
  )
}
