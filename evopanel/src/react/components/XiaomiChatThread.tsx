import { useEffect, useState } from 'react'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import { wsClient } from '../../lib/ws-client.js'
import { isEvoflowChatV4Enabled } from '../v4/v4Gate.js'
import { V4StreamRowsBridge } from '../v4/V4StreamRowsBridge.js'
import { V4ZCodeTimeline } from '../v4/V4ZCodeTimeline.js'

/**
 * 小V 对话正文：与主对话同一套 V4 面板（V4StreamRowsBridge → V4ZCodeTimeline）。
 * 输入区仍由 GlobalAssistant composer 槽负责。
 *
 * 注意：不要订阅 store 的每帧流式 patch 来 setState——否则整棵 V4 树会跟着抖。
 * 只在 threadId 从无到有（或切换会话）时更新。
 */
export function XiaomiChatThread({ sessionKey = '' }: { sessionKey?: string }) {
  const st = getState()
  const sk = String(sessionKey || st.sessionKey || '').trim()
  const [threadId, setThreadId] = useState(() =>
    sk ? String(wsClient.getSessionThreadId?.(sk) || '').trim() : '',
  )

  useEffect(() => {
    const readId = () => (sk ? String(wsClient.getSessionThreadId?.(sk) || '').trim() : '')
    setThreadId(readId())
    const unsub = subscribe(() => {
      const next = readId()
      setThreadId((prev) => (prev === next ? prev : next))
    })
    return () => {
      unsub?.()
    }
  }, [sk])

  const v4Enabled = isEvoflowChatV4Enabled()
  const sessionId = threadId || null

  return (
    <div className="xm-react-thread xm-react-thread--v4" data-xm-chat-panel="v4">
      <V4StreamRowsBridge enabled={v4Enabled} sessionId={sessionId}>
        {(v4Payload, v4Phase) => (
          <V4ZCodeTimeline
            payload={v4Payload}
            connecting={v4Phase === 'connecting' || (v4Enabled && !sessionId)}
            evoflowSessionKey={sk}
            embedded
          />
        )}
      </V4StreamRowsBridge>
    </div>
  )
}
