/**
 * 小V 对话正文 = 侧栏同一套 V4SessionPaneBridge → V4ZCodeTimeline。
 *
 * 两个宿主共用：
 * - 右栏小V标签页（XiaomiRightStagePane）
 * - 语音全屏右上角回复区（XiaomiVoiceStage）
 *
 * 本组件只做 sessionKey → thread 绑定 + 审批副作用，渲染交给统一桥。
 */
import type { ReactNode } from 'react'
import { V4SessionPaneBridge } from '../v4/V4SessionPaneBridge.js'
import { useXiaomiChatActions } from './xiaomiChatActions.js'
import { useXiaomiThreadBinding } from './useXiaomiThreadBinding.js'

export type XiaomiV4TimelineProps = {
  /** 小V 会话 key。 */
  sessionKey: string
  /** 显示面皮肤。 */
  surface?: 'default' | 'glass'
  /** 窄栏嵌入（隐藏 turn navigator、空态不居中）。 */
  embedded?: boolean
  /** 发送瞬间的乐观用户文本（V4 尚未 echo 时补一行）。 */
  optimisticUserText?: string | null
  /** 底部输入区（主聊同款 ChatComposer sticky dock）。 */
  bottomDock?: ReactNode
  /** 与停止按钮同源：驱动末轮工作中齿轮。 */
  sessionBusy?: boolean
}

export function XiaomiV4Timeline(props: XiaomiV4TimelineProps) {
  const {
    sessionKey,
    surface = 'default',
    embedded = false,
    optimisticUserText = null,
    bottomDock,
    sessionBusy = false,
  } = props
  const { threadId, workspacePath, localMsgCount } = useXiaomiThreadBinding(sessionKey)
  const actions = useXiaomiChatActions(sessionKey)

  const sessionId = String(threadId || '').trim()
  if (!sessionId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-ui-sm text-foreground-subtlest">
          {localMsgCount > 0 ? '正在连接会话…' : '准备就绪，在下方输入开始对话'}
        </div>
        {bottomDock}
      </div>
    )
  }

  return (
    <V4SessionPaneBridge
      sessionId={sessionId}
      sessionKey={sessionKey}
      evoflowSessionKey={sessionKey}
      workspacePath={actions.workspacePath || workspacePath || undefined}
      embedded={embedded}
      surface={surface}
      localMsgCount={localMsgCount}
      optimisticUserText={optimisticUserText}
      bottomDock={bottomDock}
      sessionBusy={sessionBusy}
      onToolApproval={actions.onToolApproval}
    />
  )
}
