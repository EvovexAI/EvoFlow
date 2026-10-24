/**
 * Confirm and delete a chat session (shell / more-menu).
 * Extracted from ChatApp.tsx (P43).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { showConfirm, suppressModalBackdropDismiss } from '../../../components/modal.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { clearSessionRuntime } from '../../lib/session-runtime-store.js'
import { emptyStream } from '../../lib/stream-state.js'
import { emptyThreadPanel } from '../thread-panel/state.js'
import type {
  DisplayRow,
  StreamState,
  ThreadPanelState,
  TokenTotals,
} from '../../chat-types.js'

export type HandleDeleteSessionCtx = {
  selectedSessionKey: string
  deleteSessionConfirmInflightRef: MutableRefObject<boolean>
  sessionRef: MutableRefObject<string>
  streamRef: MutableRefObject<StreamState>
  streamRefKeyRef: MutableRefObject<string>
  seenRunIdsRef: MutableRefObject<Set<string>>
  rowsRef: MutableRefObject<DisplayRow[]>
  seenArtifactsRef: MutableRefObject<{ delete: (k: string) => void }>
  composerDraftsRef: MutableRefObject<Map<string, string>>
  bumpStreamFullRef: MutableRefObject<() => void>
  setMoreMenuKey: Dispatch<SetStateAction<string | null>>
  setSelectedSessionKey: (key: string) => void
  setNewChatButtonActive: (v: boolean) => void
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  setTokenTotals: Dispatch<SetStateAction<TokenTotals | null>>
  setLiveTurnTokens: Dispatch<SetStateAction<TokenTotals | null>>
  setSubagentDockTasks: Dispatch<SetStateAction<any>>
  setSidebarTaskViews: Dispatch<SetStateAction<any>>
  setSidebarSelectedTaskId: Dispatch<SetStateAction<string | null>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setHasReceivedTodos: Dispatch<SetStateAction<boolean>>
  setBoundTaskId: Dispatch<SetStateAction<string | null>>
  removeSessionFromList: (key: string) => void
  refreshSessions: (opts: { skipAutoReselect?: boolean }) => Promise<void>
}

export async function handleDeleteSession(
  ctx: HandleDeleteSessionCtx,
  key?: string,
): Promise<void> {
  const targetKey = key || ctx.selectedSessionKey
  if (!targetKey || ctx.deleteSessionConfirmInflightRef.current) return
  ctx.deleteSessionConfirmInflightRef.current = true
  // 先收起侧栏「···」菜单，避免确认框下方仍留着「删除会话」导致第一次点击被穿透/误触
  ctx.setMoreMenuKey(null)
  try {
    await new Promise<void>((resolve) => {
      window.setTimeout(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }, 0)
    })
    suppressModalBackdropDismiss(300)
    const yes = await showConfirm('删除此会话？')
    if (!yes) return

    const { api } = await import('../../../lib/tauri-api.js')
    const viewingDeleted =
      targetKey === ctx.sessionRef.current || targetKey === ctx.selectedSessionKey

    // 侧栏先去掉条目（含搜索缓存），避免 refresh 合并草稿时从 prev 粘回（agent:*:new-*）
    ctx.removeSessionFromList(targetKey)
    clearSessionRuntime(targetKey)
    ctx.seenArtifactsRef.current.delete(targetKey)
    ctx.setMoreMenuKey((mk) => (mk === targetKey ? null : mk))

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

    await api.chatSessionsDelete(targetKey, { clearWorkspaceHistory: false })
    ctx.composerDraftsRef.current.delete(targetKey)
    await ctx.refreshSessions({ skipAutoReselect: true })
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e), 'error')
  } finally {
    ctx.deleteSessionConfirmInflightRef.current = false
  }
}
