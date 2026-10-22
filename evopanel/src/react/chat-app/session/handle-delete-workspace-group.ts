/**
 * Delete a workspace group from the shell sidebar (sessions + history path).
 * Extracted from ChatApp.tsx (P42).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { showConfirm } from '../../../components/modal.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { SESSION_LIST_PAGE_SIZE } from '../../lib/session-list/constants.js'
import {
  loadExpandedWorkspaceKeys,
  saveExpandedWorkspaceKeys,
} from '../../lib/session-list/expanded-workspaces-storage.js'
import type { ShellWorkspaceGroup } from '../../lib/session-list/types.js'
import {
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
} from '../../lib/session-list/workspace-groups.js'
import { stripDefaultMainSessionRows } from '../../lib/session-list/utils.js'
import { clearSessionRuntime } from '../../lib/session-runtime-store.js'
import { emptyStream } from '../../lib/stream-state.js'
import { emptyThreadPanel } from '../thread-panel/state.js'
import type {
  ChatSessionRow,
  DisplayRow,
  StreamState,
  ThreadPanelState,
  TokenTotals,
} from '../../chat-types.js'

export type HandleDeleteWorkspaceGroupCtx = {
  deleteWorkspaceInflightRef: MutableRefObject<boolean>
  sessionRef: MutableRefObject<string>
  streamRef: MutableRefObject<StreamState>
  streamRefKeyRef: MutableRefObject<string>
  seenRunIdsRef: MutableRefObject<Set<string>>
  rowsRef: MutableRefObject<DisplayRow[]>
  seenArtifactsRef: MutableRefObject<{ delete: (k: string) => void }>
  composerDraftsRef: MutableRefObject<Map<string, string>>
  bumpStreamFullRef: MutableRefObject<() => void>
  setSelectedSessionKey: (key: string) => void
  setNewChatButtonActive: (v: boolean) => void
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  setTokenTotals: Dispatch<SetStateAction<TokenTotals | null>>
  setLiveTurnTokens: Dispatch<SetStateAction<TokenTotals | null>>
  // ChatApp uses typed Record maps; we only clear to {}.
  setSubagentDockTasks: Dispatch<SetStateAction<any>>
  setSidebarTaskViews: Dispatch<SetStateAction<any>>
  setSidebarSelectedTaskId: Dispatch<SetStateAction<string | null>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setHasReceivedTodos: Dispatch<SetStateAction<boolean>>
  setBoundTaskId: Dispatch<SetStateAction<string | null>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  removeSessionFromList: (key: string) => void
  purgeWorkspaceFromSidebar: (
    workspaceKey: string,
    opts: { skipSessions: boolean },
  ) => void
  refreshSessions: (opts: {
    skipAutoReselect?: boolean
    summariesOnly?: boolean
  }) => Promise<void>
  removeWorkspaceHistoryPath: (path: string) => Promise<void>
}

export async function handleDeleteWorkspaceGroup(
  ctx: HandleDeleteWorkspaceGroupCtx,
  group: ShellWorkspaceGroup,
): Promise<void> {
  if (ctx.deleteWorkspaceInflightRef.current) return
  const workspaceKey = group.workspaceKey
  if (isSpecialWorkspaceGroupKey(workspaceKey)) {
    return
  }

  const removePath =
    String(group.path || '').trim() ||
    (!isSpecialWorkspaceGroupKey(workspaceKey) ? workspaceKey : '')
  const count = group.sessionCount || 0
  const label = group.label || removePath
  const confirmMsg =
    count > 0
      ? `该目录下还有 ${count} 个会话，是否一并删除？\n\n工作空间：${label}\n此操作不可恢复。`
      : `从侧栏移除工作空间「${label}」？\n\n无会话，仅删除历史记录。`

  ctx.deleteWorkspaceInflightRef.current = true
  try {
    const yes = await showConfirm(confirmMsg)
    if (!yes) return

    const { api } = await import('../../../lib/tauri-api.js')
    const allKeys: string[] = []
    let offset = 0
    for (;;) {
      const data = await api.chatSessionsList(SESSION_LIST_PAGE_SIZE, offset, workspaceKey)
      const apiRows = (data?.sessions || []) as ChatSessionRow[]
      for (const s of stripDefaultMainSessionRows(apiRows)) {
        const k = String(s.sessionKey || '').trim()
        if (k) allKeys.push(k)
      }
      if (apiRows.length < SESSION_LIST_PAGE_SIZE) break
      offset += apiRows.length
    }

    const keysSet = new Set(allKeys)
    const viewingDeleted = !!ctx.sessionRef.current && keysSet.has(ctx.sessionRef.current)

    if (allKeys.length > 0) {
      for (const k of allKeys) {
        ctx.removeSessionFromList(k)
        clearSessionRuntime(k)
        ctx.seenArtifactsRef.current.delete(k)
      }
    }

    if (viewingDeleted) {
      ctx.sessionRef.current = ''
      ctx.setSelectedSessionKey('')
      ctx.setNewChatButtonActive(true)
      ctx.streamRef.current = emptyStream()
      ctx.streamRefKeyRef.current = ''
      ctx.seenRunIdsRef.current = new Set()
      ctx.rowsRef.current = []
      ctx.setRows([])
      ctx.setTokenTotals(null)
      ctx.setLiveTurnTokens(null)
      ctx.setSubagentDockTasks({})
      ctx.setSidebarTaskViews({})
      ctx.setSidebarSelectedTaskId(null)
      ctx.setThreadPanelState(emptyThreadPanel())
      ctx.setHasReceivedTodos(false)
      ctx.setBoundTaskId(null)
      ctx.bumpStreamFullRef.current()
    }

    for (const k of allKeys) {
      ctx.composerDraftsRef.current.delete(k)
      await api.chatSessionsDelete(k, { clearWorkspaceHistory: false })
    }

    if (removePath) {
      await ctx.removeWorkspaceHistoryPath(removePath)
    }
    ctx.setGlobalWorkspaceHistory((prev) =>
      prev.filter((p) => normalizeWorkspacePathKey(p) !== workspaceKey),
    )
    ctx.purgeWorkspaceFromSidebar(workspaceKey, { skipSessions: allKeys.length > 0 })

    const expanded = loadExpandedWorkspaceKeys()
    expanded.delete(workspaceKey)
    saveExpandedWorkspaceKeys(expanded)

    await ctx.refreshSessions({ skipAutoReselect: true, summariesOnly: true })
    toast(
      count > 0 ? `已删除工作空间及 ${count} 个会话` : '已从侧栏移除工作空间',
      'success',
    )
  } catch (err) {
    toast(toUserFacingError((err as Error)?.message || err), 'error')
  } finally {
    ctx.deleteWorkspaceInflightRef.current = false
  }
}
