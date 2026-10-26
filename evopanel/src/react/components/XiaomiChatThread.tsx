import { XiaomiV4Timeline } from './XiaomiV4Timeline.js'

/**
 * 小V 对话正文 = 主对话同一套 V4（V4StreamRowsBridge → ConversationTimeline）。
 * 窄栏 embedded：隐藏 turn navigator；接上审批 / 工作区 / 代码预览，缩小与主对话差距。
 *
 * 实现细节已收敛到 XiaomiV4Timeline：右栏小V标签页与语音全屏右上角回复区
 * 共用同一份装配，保证两处看到的是同一条会话、同一套工具卡行为。
 */
export function XiaomiChatThread({ sessionKey = '' }: { sessionKey?: string }) {
  return (
    <div className="xm-react-thread xm-react-thread--v4" data-xm-chat-panel="v4">
      <XiaomiV4Timeline sessionKey={sessionKey} embedded />
    </div>
  )
}
