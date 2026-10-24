/**
 * UI「开始执行」: resolve task id, authorize, then send lead monitor message.
 * Extracted from ChatApp.tsx (P45).
 */
import type { MutableRefObject } from 'react'
import { toast } from '../../../components/toast.js'
import { extractLastPlanToolSuccessFromArrays } from '../../../lib/collab-sidebar-from-tools.js'
import { resolvePlanBoundTaskId } from '../../../lib/plan-exec-ui.js'

export type RunUserExecutionStartCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  planExecStartInFlightRef: MutableRefObject<boolean>
  setPlanExecStarting: (v: boolean) => void
  planExecToolArrays: unknown[][]
  threadPanelState: {
    collabTask?: { taskId?: string | null } | null
    boundTaskId?: string | null
    collabSubtasks?: Array<{ parentTaskId?: string | null }> | null
  }
  boundTaskId: string | null
  resolveLangGraphThreadIdForSession: (sessionKey: string) => Promise<string>
  authorizeExecutionInBackground: (
    taskId: string,
    threadIdHint: string,
  ) => Promise<boolean>
  handleSend: (text: string) => Promise<unknown> | unknown
}

export async function runUserExecutionStart(
  ctx: RunUserExecutionStartCtx,
  taskId: string,
): Promise<void> {
  if (ctx.planExecStartInFlightRef.current) return
  ctx.planExecStartInFlightRef.current = true
  ctx.setPlanExecStarting(true)
  let tid = String(taskId || '').trim()
  const sk = String(ctx.sessionRef.current || ctx.selectedSessionKey || '').trim()
  try {
    if (!tid && sk) {
      const hit = extractLastPlanToolSuccessFromArrays(ctx.planExecToolArrays)
      tid = await resolvePlanBoundTaskId({
        sessionKey: sk,
        // @ts-ignore — planOutput shape varies by tool payload
        planOutput: (hit?.planOutput as Record<string, unknown> | undefined) ?? null,
        hintTaskId: String(
          ctx.threadPanelState.collabTask?.taskId ||
            ctx.threadPanelState.boundTaskId ||
            ctx.boundTaskId ||
            ctx.threadPanelState.collabSubtasks?.[0]?.parentTaskId ||
            '',
        ).trim(),
      })
    }
    if (tid) {
      const threadId = await ctx.resolveLangGraphThreadIdForSession(sk)
      const authorized = await ctx.authorizeExecutionInBackground(tid, threadId)
      if (!authorized) return
    } else {
      toast('未找到可授权的任务 ID，请稍候或刷新后重试', 'warning')
      return
    }
    await ctx.handleSend('开始执行')
  } finally {
    ctx.planExecStartInFlightRef.current = false
    ctx.setPlanExecStarting(false)
  }
}
