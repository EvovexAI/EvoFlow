/**
 * Create a new chat session (optional workspace bind) and optionally adopt it.
 * Extracted from ChatApp.tsx (P56).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { skTail, ssLog } from '../../../lib/session-list-debug.js'
import { prependNewSessionToList } from '../../lib/session-list/utils.js'
import { setSessionModeInMeta, type SessionMode } from '../../lib/session-mode.js'
import type { ChatSessionRow, DisplayRow, TokenTotals } from '../../chat-types.js'

export type CreateSessionForChatCtx = {
  memoryEnabled: boolean
  sessionRef: MutableRefObject<string>
  pendingNewSessionRef: MutableRefObject<boolean>
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>
  setSessionMode: (mode: SessionMode) => void
  setSelectedSessionKey: (key: string) => void
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  setTokenTotals: Dispatch<SetStateAction<TokenTotals | null>>
  setLiveTurnTokens: Dispatch<SetStateAction<TokenTotals | null>>
  setNewChatButtonActive: (v: boolean) => void
  setWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  markSessionKnownEmpty: (key: string) => void
  bindSessionWorkspace: (
    key: string,
    ws: string,
    opts: { userPinned: boolean },
  ) => Promise<{ paths?: unknown[] } | null | undefined>
  getGlobalWorkspaceHistory: () => string[]
  finalizeNewSessionBackground: (key: string) => void
}

export async function createSessionForChat(
  ctx: CreateSessionForChatCtx,
  opts?: { workspaceRoot?: string | null },
): Promise<string | null> {
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const createContext: Record<string, unknown> = { memory_enabled: ctx.memoryEnabled }
    const ws =
      opts && 'workspaceRoot' in opts ? String(opts.workspaceRoot ?? '').trim() : ''
    if (ws) {
      createContext.local_workspace_root = ws
      createContext.use_virtual_paths = false
      createContext.workspace_user_pinned = true
    }
    const row = (await api.chatSessionsCreate('main', {
      title: '新对话',
      context: createContext,
      ensureThread: false, // 不阻塞等待 LangGraph 线程；用户发消息时按需创建（已有超时保护）
    })) as ChatSessionRow & { key?: string }
    const key = String(row?.sessionKey || row?.key || '').trim()
    if (!key) throw new Error('创建会话失败')
    // Before adopt: known-empty latch keeps home surface mounted (no historyLoading skeleton).
    ctx.markSessionKnownEmpty(key)
    if (ws) {
      try {
        const bound = await ctx.bindSessionWorkspace(key, ws, { userPinned: true })
        const nextHist = Array.isArray(bound?.paths)
          ? bound.paths.map((x: unknown) => String(x || '').trim()).filter(Boolean)
          : [ws]
        if (String(ctx.sessionRef.current || '').trim() === key) {
          ctx.setWorkspaceHistory(nextHist)
          ctx.setGlobalWorkspaceHistory(ctx.getGlobalWorkspaceHistory())
        }
      } catch {
        /* create context 已写入 workspace；bind 失败不阻断新建 */
      }
    }
    ssLog('create.done', {
      key: skTail(key),
      sessionRefBefore: skTail(ctx.sessionRef.current),
      workspace: ws || '(default)',
    })
    const enrichedRow = ws
      ? {
          ...row,
          localWorkspaceRoot: ws,
          useVirtualPaths: false,
          context: {
            ...(row.context && typeof row.context === 'object' ? row.context : {}),
            local_workspace_root: ws,
            use_virtual_paths: false,
            workspace_user_pinned: true,
          },
        }
      : row
    prependNewSessionToList(ctx.setSessions, enrichedRow as ChatSessionRow & { key?: string })
    // 新建会话默认 Agent 模式，不继承上一个会话的模式
    setSessionModeInMeta(key, 'agent')
    ctx.setSessionMode('agent')
    const curSel = String(ctx.sessionRef.current || '').trim()
    // pendingNew 时强制 adopt：列表刷新可能已把选中抢回历史会话
    const forceAdopt = ctx.pendingNewSessionRef.current || !curSel
    if (forceAdopt) {
      ssLog('create.adopt', {
        key: skTail(key),
        forced: !!ctx.pendingNewSessionRef.current,
        prev: skTail(curSel),
      })
      ctx.setSelectedSessionKey(key)
      ctx.sessionRef.current = key
      ctx.setRows([])
      ctx.setTokenTotals(null)
      ctx.setLiveTurnTokens(null)
      ctx.setNewChatButtonActive(false)
    } else {
      ssLog('create.skip-adopt', { key: skTail(key), curSel: skTail(curSel) })
    }
    void ctx.finalizeNewSessionBackground(key)
    return key
  } catch (e) {
    ctx.setNewChatButtonActive(true)
    toast(toUserFacingError((e as Error)?.message || e), 'error')
    return null
  }
}
