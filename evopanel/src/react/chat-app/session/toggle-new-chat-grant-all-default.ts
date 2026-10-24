/**
 * Toggle global「新对话默认完全访问」and optionally apply to current session.
 * Extracted from ChatApp.tsx (P55).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'

export type ToggleNewChatGrantAllDefaultCtx = {
  setToolApprovalPolicyTick: Dispatch<SetStateAction<number>>
  patchGlobalToolApprovalPolicy: (policy: string) => Promise<unknown>
  toolApprovalPolicyGrantAll: string
  toolApprovalPolicySession: string
  applyFullAccessToCurrentSession: (opts?: { quiet?: boolean }) => Promise<void>
  fetchGlobalToolApprovalPolicy: () => Promise<unknown>
}

export async function toggleNewChatGrantAllDefault(
  ctx: ToggleNewChatGrantAllDefaultCtx,
  next: boolean,
): Promise<void> {
  const policy = next ? ctx.toolApprovalPolicyGrantAll : ctx.toolApprovalPolicySession
  try {
    await ctx.patchGlobalToolApprovalPolicy(policy)
    ctx.setToolApprovalPolicyTick((n) => n + 1)
    if (next) {
      await ctx.applyFullAccessToCurrentSession({ quiet: true })
      toast('已开启：新对话默认完全访问；本会话已切换为完全访问', 'success')
    } else {
      toast('新对话默认：帮我批准（风险操作询问）', 'success')
    }
  } catch (err) {
    toast(String((err as Error)?.message || err) || '保存失败', 'error')
    void ctx.fetchGlobalToolApprovalPolicy().catch(() => {})
  }
}
