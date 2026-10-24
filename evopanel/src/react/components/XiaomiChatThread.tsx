import { useCallback, useEffect, useState } from 'react'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import { wsClient } from '../../lib/ws-client.js'
import { isEvoflowChatV4Enabled } from '../v4/v4Gate.js'
import { V4StreamRowsBridge } from '../v4/V4StreamRowsBridge.js'
import { V4ZCodeTimeline } from '../v4/V4ZCodeTimeline.js'
import { showRightStageCodeViewer } from '../../lib/right-stage/open-right-stage-file.js'
import { toast } from '../../components/toast.js'

function readThreadId(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  return String(wsClient.getSessionThreadId?.(sk) || '').trim()
}

function readWorkspacePath(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  try {
    const ctx = wsClient.getSessionContext?.(sk) || {}
    return String(ctx.local_workspace_root || ctx.localWorkspaceRoot || '').trim()
  } catch {
    return ''
  }
}

/**
 * 小V 对话正文 = 主对话同一套 V4（V4StreamRowsBridge → ConversationTimeline）。
 * 窄栏 embedded：隐藏 turn navigator；接上审批 / 工作区 / 代码预览，缩小与主对话差距。
 */
export function XiaomiChatThread({ sessionKey = '' }: { sessionKey?: string }) {
  const st0 = getState()
  const sk = String(sessionKey || st0.sessionKey || '').trim()
  const [threadId, setThreadId] = useState(() => readThreadId(sk))
  const [localMsgCount, setLocalMsgCount] = useState(() =>
    Array.isArray(st0.messages) ? st0.messages.length : 0,
  )
  const [workspacePath, setWorkspacePath] = useState(() => readWorkspacePath(sk))

  useEffect(() => {
    const syncMeta = () => {
      const s = getState()
      setLocalMsgCount(Array.isArray(s.messages) ? s.messages.length : 0)
      const next = readThreadId(sk)
      setThreadId((prev) => (prev === next ? prev : next))
      setWorkspacePath(readWorkspacePath(sk))
    }
    syncMeta()
    const unsub = subscribe(syncMeta)
    const onRebound = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; threadId?: string }>).detail
      if (String(detail?.sessionKey || '').trim() !== sk) return
      const next = String(detail?.threadId || '').trim() || readThreadId(sk)
      if (next) setThreadId(next)
    }
    window.addEventListener('evopanel:session-thread-rebound', onRebound)
    const needPoll = !readThreadId(sk) && (getState().streaming || localMsgCount > 0)
    const poll = window.setInterval(() => {
      const next = readThreadId(sk)
      if (next) setThreadId((prev) => (prev === next ? prev : next))
    }, needPoll ? 300 : 2500)
    return () => {
      unsub?.()
      window.removeEventListener('evopanel:session-thread-rebound', onRebound)
      window.clearInterval(poll)
    }
  }, [sk, localMsgCount])

  const onToolApproval = useCallback(
    async (
      action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
      toolCallId?: string,
      hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
    ) => {
      const tid = readThreadId(sk)
      if (!tid) {
        toast('会话线程未就绪，请稍后再试', 'warning')
        return
      }
      try {
        await wsClient.postToolApproval(tid, {
          action: action === 'approve_remember' ? 'approve' : action,
          tool_call_id: toolCallId,
          local_workspace_root: readWorkspacePath(sk) || undefined,
          tool_name: hint?.tool_name,
          args: hint?.args,
          summary: hint?.summary,
          remember: action === 'approve_remember',
        })
      } catch (e) {
        toast(String((e as Error)?.message || e || '授权失败'), 'error')
      }
    },
    [sk],
  )

  const onOpenCodeViewer = useCallback(
    (source: import('@zcode/ui/lib/codeViewer.js').CodeViewerSource) => {
      // 与主对话同一入口：右栏半宽，不走全屏 modal
      showRightStageCodeViewer(source, {
        sessionKey: sk,
        threadId: readThreadId(sk),
      })
    },
    [sk],
  )

  const v4Enabled = isEvoflowChatV4Enabled()
  const sessionId = threadId || null

  return (
    <div className="xm-react-thread xm-react-thread--v4" data-xm-chat-panel="v4">
      <V4StreamRowsBridge enabled={v4Enabled} sessionId={sessionId}>
        {(v4Payload, v4Phase) => {
          const v4RowCount = v4Payload?.snapshot?.rows.totalCount ?? 0
          // 仅 V4 ready 且确认无行才草稿问候；connecting 不算（对齐主对话）
          const draftEmpty =
            localMsgCount === 0 && v4Phase === 'ready' && !!sessionId && v4RowCount === 0
          return (
            <V4ZCodeTimeline
              payload={v4Payload}
              connecting={
                v4Phase === 'connecting' ||
                v4Phase === 'no-thread' ||
                (v4Enabled && !sessionId && localMsgCount > 0)
              }
              draftEmpty={draftEmpty}
              evoflowSessionKey={sk}
              embedded
              onToolApproval={onToolApproval}
              workspacePath={workspacePath || undefined}
              onOpenCodeViewer={onOpenCodeViewer}
            />
          )
        }}
      </V4StreamRowsBridge>
    </div>
  )
}
