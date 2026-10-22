/**
 * Fork chat session (shell menu + from message).
 * Extracted from ChatApp.tsx (P23).
 */
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'

export type ForkSessionCtx = {
  refreshSessions: (opts?: { skipAutoReselect?: boolean }) => Promise<void> | void
  selectSession: (sessionKey: string) => void
}

export async function forkSessionByKey(
  ctx: ForkSessionCtx,
  sessionKey: string,
  opts?: { throughMessageId?: string; successToast?: string },
): Promise<void> {
  const key = String(sessionKey || '').trim()
  if (!key) return
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const mid = String(opts?.throughMessageId || '').trim()
    const data = mid
      ? await api.chatSessionsFork(key, { throughMessageId: mid })
      : await api.chatSessionsFork(key)
    const newKey = String(data?.sessionKey || data?.session?.sessionKey || '').trim()
    if (!newKey) throw new Error('分叉失败：未返回新会话')
    await ctx.refreshSessions({ skipAutoReselect: true })
    ctx.selectSession(newKey)
    toast(opts?.successToast || '已分叉会话', 'success')
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e || '分叉失败'), 'error')
  }
}
