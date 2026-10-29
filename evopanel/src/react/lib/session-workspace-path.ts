/**
 * 会话绑定的本地工作区根（员工绑定 workspace / 普通会话 local_workspace_root）。
 * V4 正文里的相对路径（如 projects\\foo.mp4）要拼到这个前缀才能打开。
 */
import { wsClient } from '../../lib/ws-client.js'
import { getChatWorkspaceRoot } from '../../lib/chat-workspace-context.js'

export function readSessionWorkspacePath(sessionKey: string | null | undefined): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  try {
    const ctx = (wsClient.getSessionContext?.(sk) || {}) as {
      local_workspace_root?: string
      localWorkspaceRoot?: string
    }
    return String(ctx.local_workspace_root || ctx.localWorkspaceRoot || '').trim()
  } catch {
    return ''
  }
}

/**
 * 解析「当前这条 V4 时间线」该用的 workspace 根：
 * 显式 prop → 员工/子会话 key → 归属 sessionKey → 主聊全局根。
 */
export function resolveTimelineWorkspacePath(opts: {
  workspacePath?: string | null
  evoflowSessionKey?: string | null
  sessionKey?: string | null
}): string {
  const explicit = String(opts.workspacePath || '').trim()
  if (explicit) return explicit
  return (
    readSessionWorkspacePath(opts.evoflowSessionKey) ||
    readSessionWorkspacePath(opts.sessionKey) ||
    String(getChatWorkspaceRoot() || '').trim()
  )
}
