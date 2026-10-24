/**
 * Approve / deny / grant-all pending tool calls for the selected session.
 * Extracted from ChatApp.tsx (P67).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import {
  collectPendingApprovalsForDock,
  patchToolsApprovalStatus,
  buildToolApprovalReplayMessage,
} from '../../../lib/tool-approval.js'
import { logToolApprovalUserAction } from '../../../lib/tool-approval-trace.js'
import {
  getSessionRuntime,
  dispatchSessionTurnEvent,
} from '../../lib/session-runtime-store.js'
import type { DisplayRow, StreamState } from '../../chat-types.js'

export type ToolApprovalAction =
  | 'approve'
  | 'approve_all'
  | 'deny'
  | 'grant_all'
  | 'approve_remember'

export type HandleToolApprovalCtx = {
  selectedSessionKey: string
  sessionRef: { current: string }
  streamRef: { current: StreamState }
  rowsRef: { current: DisplayRow[] }
  toolApprovalResolvedIdsRef: { current: Set<string> }
  suppressToolApprovalToastRef: { current: boolean }
  requestManualStreamResumeRef: {
    current: (sk: string, opts?: { refreshSessions?: boolean }) => void
  }
  setToolApprovalInFlight: Dispatch<SetStateAction<boolean>>
  permissionPresetFullAccess: string
  applyMoreMenuSessionApprovalPolicy: (
    presetId: string,
    opts?: { quiet?: boolean },
  ) => Promise<void>
  turnBusyForSession: (sk: string) => boolean
  scheduleBump: (opts?: { immediate?: boolean }) => void
  setExpectedChatRunId: (sk: string, rid: string | null) => void
}

export async function handleToolApproval(
  ctx: HandleToolApprovalCtx,
  action: ToolApprovalAction,
  toolCallId?: string,
  hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
): Promise<void> {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return
  const { wsClient } = await import('../../../lib/ws-client.js')
  const tid = wsClient.getSessionThreadId(sk)
  if (!tid) {
    toast('会话尚未就绪，请稍后重试', 'error')
    return
  }
  const sessionCtx = wsClient.getSessionContext(sk) || {}
  const wsRoot = String(sessionCtx.local_workspace_root || '').trim() || undefined
  const tcKey = String(toolCallId || '').trim()
  logToolApprovalUserAction(action, {
    sessionKey: sk,
    threadId: tid,
    toolCallId: tcKey,
    toolName: hint?.tool_name,
    摘要: hint?.summary,
  })
  const markResolved = (ids: string[]) => {
    for (const id of ids) {
      const k = String(id || '').trim()
      if (k) ctx.toolApprovalResolvedIdsRef.current.add(k)
    }
  }
  const patchLocalToolApprovalStatus = (ids: string[], status: string) => {
    const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)
    if (!list.length) return
    patchToolsApprovalStatus((ctx.streamRef.current?.turn.tools as unknown[]) || [], list, status)
    const rt = getSessionRuntime(sk)
    for (const row of rt.rows || []) {
      patchToolsApprovalStatus(((row as { tools?: unknown[] })?.tools as unknown[]) || [], list, status)
    }
    for (const row of ctx.rowsRef.current || []) {
      patchToolsApprovalStatus(((row as { tools?: unknown[] })?.tools as unknown[]) || [], list, status)
    }
    ctx.scheduleBump({ immediate: true })
  }
  const pendingVisible = collectPendingApprovalsForDock({
    streamTools: (ctx.streamRef.current?.turn.tools as unknown[]) || [],
    rows: ctx.rowsRef.current,
    isSending: ctx.turnBusyForSession(ctx.sessionRef.current),
    excludeToolCallIds: ctx.toolApprovalResolvedIdsRef.current,
  })
  ctx.setToolApprovalInFlight(true)
  try {
    const notify = (message: string, kind: 'info' | 'success' | 'error' = 'info') => {
      if (!ctx.suppressToolApprovalToastRef.current) toast(message, kind)
    }
    const res = await wsClient.postToolApproval(tid, {
      action: action === 'approve_remember' ? 'approve' : action,
      tool_call_id: toolCallId,
      local_workspace_root: wsRoot,
      tool_name: hint?.tool_name,
      args: hint?.args,
      summary: hint?.summary,
      remember: action === 'approve_remember',
    })
    logToolApprovalUserAction(`${action} API 响应`, {
      sessionKey: sk,
      threadId: tid,
      消息: res?.message,
      stream_resume_recommended: res?.stream_resume_recommended,
      resume_run_id: res?.resume_run_id,
      replay_ids: res?.replay_tool_call_ids,
    })
    if (action === 'grant_all' || action === 'approve_all') {
      markResolved(pendingVisible.map((p) => p.tool_call_id))
      patchLocalToolApprovalStatus(
        pendingVisible.map((p) => p.tool_call_id),
        'approved',
      )
      if (action === 'grant_all') {
        // 后端已落 grant_all；本地 pill / context 立刻对齐，避免仍显示「帮我批准」
        try {
          await ctx.applyMoreMenuSessionApprovalPolicy(ctx.permissionPresetFullAccess, {
            quiet: true,
          })
        } catch {
          /* 审批已成功；档位同步失败不阻断续流 */
        }
      }
    } else if (action === 'deny') {
      markResolved([tcKey])
      patchLocalToolApprovalStatus([tcKey], 'denied')
      notify(res?.message || '已拒绝', 'info')
      ctx.scheduleBump({ immediate: true })
      return
    } else if (action === 'approve' || action === 'approve_remember') {
      markResolved([tcKey])
      const ids =
        Array.isArray(res?.replay_tool_call_ids) && res.replay_tool_call_ids.length
          ? res.replay_tool_call_ids
          : [tcKey]
      patchLocalToolApprovalStatus(ids, 'approved')
    }
    if (res?.client_stream_replay) {
      notify(res?.message || '已批准，正在执行…', 'info')
      const ids =
        Array.isArray(res?.replay_tool_call_ids) && res.replay_tool_call_ids.length
          ? res.replay_tool_call_ids
          : []
      const replayMsg =
        String(res?.replay_message || '').trim() ||
        (ids.length ? buildToolApprovalReplayMessage(ids) : '')
      if (replayMsg) {
        // Open a fresh POST /runs/stream owned by the browser so the next
        // model reply streams token-by-token (history-watch only dumps DB).
        void wsClient.chatSend(sk, replayMsg, [], [], {}).catch((err: unknown) => {
          toast(toUserFacingError((err as Error)?.message || err, '续流失败'), 'error')
          window.setTimeout(() => {
            ctx.requestManualStreamResumeRef.current(sk, { refreshSessions: true })
          }, 400)
        })
      } else {
        window.setTimeout(() => {
          ctx.requestManualStreamResumeRef.current(sk, { refreshSessions: true })
        }, 400)
      }
    } else if (res?.stream_resume_recommended) {
      notify(res?.message || '已批准，正在执行…', 'info')
      // Do NOT pre-dispatch REATTACH_STARTED here: if reattach is skipped
      // (cooldown / missing runId), turnPhase would stick on reattaching.
      // requestManualStreamResume owns REATTACH_STARTED → TURN_IDLE.
      const resumeRunId = String(res?.resume_run_id || '').trim()
      if (resumeRunId) ctx.setExpectedChatRunId(sk, resumeRunId)
      window.setTimeout(() => {
        ctx.requestManualStreamResumeRef.current(sk, { refreshSessions: true })
      }, 400)
      // Safety: if history-watch never starts/ends, don't leave spinner forever.
      window.setTimeout(() => {
        const rt = getSessionRuntime(sk)
        if (rt.turnPhase === 'reattaching' || rt.turnPhase === 'degraded') {
          void (async () => {
            try {
              const { isSessionRunStillActive } = await import('../../lib/session-reattach.js')
              if (!(await isSessionRunStillActive(sk))) {
                dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
              }
            } catch {
              /* ignore */
            }
          })()
        }
      }, 8000)
    } else {
      notify(res?.message || '已记录授权，同一条流继续…', 'info')
    }
    ctx.scheduleBump({ immediate: true })
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e, '授权请求失败'), 'error')
  } finally {
    ctx.setToolApprovalInFlight(false)
  }
}
