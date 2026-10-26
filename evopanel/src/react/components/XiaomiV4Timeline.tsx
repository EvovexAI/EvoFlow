/**
 * 小V 对话正文 = 主对话同一套 V4（V4StreamRowsBridge → ConversationTimeline）。
 *
 * 三个宿主共用本组件，保证「同一条会话、同一份渲染、同一套右栏副作用」：
 * - 右栏小V标签页（XiaomiRightStagePane）
 * - 语音全屏右上角回复区（XiaomiVoiceStage）
 *
 * 差异只在 skin：
 * - surface="default"：主对话同款（zcode token 卡片）
 * - surface="glass"：语音浮层皮肤（宿主明暗 + 玻璃底 + 更紧行距）
 *
 * 渲染管线完全一致 —— 轮分组 / live tail 流式 / 工具卡 / 贴底跟随都由
 * zcode-ui/v4 负责，这里只做数据与宿主副作用装配。
 */
import { V4StreamRowsBridge } from '../v4/V4StreamRowsBridge.js'
import { V4ZCodeTimeline } from '../v4/V4ZCodeTimeline.js'
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
}

export function XiaomiV4Timeline(props: XiaomiV4TimelineProps) {
  const { sessionKey, surface = 'default', embedded = false, optimisticUserText = null } = props
  const { threadId, workspacePath, localMsgCount } = useXiaomiThreadBinding(sessionKey)
  const actions = useXiaomiChatActions(sessionKey)

  const sessionId = threadId || null

  return (
    <V4StreamRowsBridge enabled={!!sessionId} sessionId={sessionId}>
      {(v4Payload, v4Phase) => {
        const v4RowCount = v4Payload?.snapshot?.rows.totalCount ?? 0
        // 仅 V4 ready 且确认无行才草稿问候；connecting 不算（对齐主对话）
        const isDraft = localMsgCount === 0 && v4Phase === 'ready' && v4RowCount === 0
        return (
          <V4ZCodeTimeline
            payload={v4Payload}
            connecting={
              v4Phase === 'connecting' ||
              v4Phase === 'no-thread' ||
              (!sessionId && localMsgCount > 0)
            }
            draftEmpty={isDraft}
            evoflowSessionKey={sessionKey}
            embedded={embedded}
            surface={surface}
            optimisticUserText={optimisticUserText}
            onToolApproval={actions.onToolApproval}
            workspacePath={actions.workspacePath || workspacePath || undefined}
            onOpenFileLink={actions.onOpenFileLink}
            onOpenCodeViewer={actions.onOpenCodeViewer}
            onOpenBrowserUrl={actions.onOpenBrowserUrl}
          />
        )
      }}
    </V4StreamRowsBridge>
  )
}
