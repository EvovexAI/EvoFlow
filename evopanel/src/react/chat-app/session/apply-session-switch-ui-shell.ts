/**
 * On selectedSessionKey change: persist drafts/panels, reset UI shell, restore workspace.
 * Extracted from ChatApp.tsx (P71).
 */
import type { Dispatch, SetStateAction } from 'react'
import {
  getSessionRuntime,
  isTurnBusy,
} from '../../lib/session-runtime-store.js'
import { invalidateSessionRuntimeStatusCache } from '../../lib/session-reattach.js'
import { clearClarificationLatch } from '../../lib/clarify-tool-fetch.js'
import { resetStreamMirrorDedupe } from '../../stream-console-mirror.js'
import { resetPlanTrace } from '../../../lib/plan-trace.js'
import { parseProactiveSessionKey } from '../../lib/session-list/workspace-groups.js'
import {
  getSessionModeFromMeta,
  type SessionMode,
} from '../../lib/session-mode.js'
import { getSessionCollabModeFromMeta } from '../utils/session-meta.js'
import { emptyThreadPanel } from '../thread-panel/state.js'
import { clearThreadPanelClarification } from '../thread-panel/clarification.js'
import { findAskClarificationAwaitingUserInRows } from '../../../lib/clarify-preview-resolve.js'
import type { ContextFileEntry } from '../../components/WorkspaceFileTree.js'
import type { DisplayRow, ThreadPanelState } from '../../chat-types.js'

export type ApplySessionSwitchUiShellCtx = {
  selectedSessionKey: string
  sessionSwitchFromRef: { current: string | null | undefined }
  composerTextRef: { current: string }
  composerDraftsRef: { current: Map<string, string> }
  threadPanelStateRef: { current: ThreadPanelState }
  threadPanelBySessionRef: { current: Map<string, ThreadPanelState> }
  planSessionEnterRef: { current: string }
  refreshAttachAttemptedRef: { current: Record<string, unknown> }
  lastStreamWritePathRef: { current: string | null }
  planResolveInFlightRef: { current: boolean }
  processedTaskIdRef: { current: string | null }
  boundTaskIdRef: { current: string | null }
  lastActivityRef: { current: Record<string, number> }
  pendingComposerDraftCarryRef: { current: string | null }
  pendingNewSessionWorkspaceRef: {
    current: { sessionKey?: string; path?: string } | null
  }
  sessionRef: { current: string }
  rowsRef: { current: DisplayRow[] }
  bumpStreamFullRef: { current: () => void }
  setStreamingWritePreview: (v: null) => void
  setWorkspacePanelOpen: (v: boolean) => void
  setWorkspaceTreePinned: (v: boolean) => void
  setSubagentDockTasks: (v: Record<string, unknown>) => void
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setHasReceivedTodos: (v: boolean) => void
  setSessionMode: (mode: SessionMode) => void
  setCollabOn: (v: boolean) => void
  setModeMenuOpen: (v: boolean) => void
  setLocalWorkspaceRoot: (v: string) => void
  setContextFiles: Dispatch<SetStateAction<ContextFileEntry[]>>
  setWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  shellIntentWorkspaceRef: { current: string | null }
  syncShellAsideForWorkspacePanel: (open: boolean) => void
  resetCollabPlanUiForSession: (opts: {
    keepBoundTaskId: boolean
    closeSidebar: boolean
  }) => void
  maybeEndTurnSendingState: (
    sk: string,
    rt: ReturnType<typeof getSessionRuntime>,
    isBackground: boolean,
  ) => void
  restoreComposerDraft: (draft: string) => void
  getSessionContext: (sk: string) => Record<string, unknown>
  getWorkspaceHistory: (sk: string) => string[]
  getGlobalWorkspaceHistory: () => string[]
}

export function applySessionSwitchUiShell(ctx: ApplySessionSwitchUiShellCtx): void {
  const selectedSessionKey = ctx.selectedSessionKey
  // 切换会话：流式快照在上方 useLayoutEffect 已 persist/restore；此处只清 UI 壳层状态。
  const fromKey = ctx.sessionSwitchFromRef.current
  if (fromKey) {
    const prevDraft = ctx.composerTextRef.current
    if (prevDraft) ctx.composerDraftsRef.current.set(fromKey, prevDraft)
    else ctx.composerDraftsRef.current.delete(fromKey)
    ctx.threadPanelBySessionRef.current.set(fromKey, ctx.threadPanelStateRef.current)
    ctx.planSessionEnterRef.current = ''
  }
  delete ctx.refreshAttachAttemptedRef.current[selectedSessionKey]

  queueMicrotask(() => {
    ctx.setStreamingWritePreview(null)
    ctx.setWorkspacePanelOpen(false)
    ctx.setWorkspaceTreePinned(false)
    ctx.setSubagentDockTasks({})
  })
  ctx.lastStreamWritePathRef.current = null
  resetStreamMirrorDedupe()
  resetPlanTrace()
  ctx.planResolveInFlightRef.current = false
  ctx.syncShellAsideForWorkspacePanel(false)
  const isTaskJump =
    ctx.processedTaskIdRef.current &&
    ctx.boundTaskIdRef.current === ctx.processedTaskIdRef.current
  ctx.resetCollabPlanUiForSession({ keepBoundTaskId: !!isTaskJump, closeSidebar: true })
  if (selectedSessionKey) {
    // 切会话时立即校验：若新选中的会话看起来 busy，查 DB 确认是否真的还在运行
    const switchSk = String(selectedSessionKey).trim()
    const switchRt = getSessionRuntime(switchSk)
    if (isTurnBusy(switchRt)) {
      invalidateSessionRuntimeStatusCache(switchSk)
      void ctx.maybeEndTurnSendingState(switchSk, switchRt, false)
    }
    ctx.lastActivityRef.current[selectedSessionKey] = Date.now()
    clearClarificationLatch(selectedSessionKey)
    const cachedPanel = ctx.threadPanelBySessionRef.current.get(selectedSessionKey)
    const switchRows = switchRt.rows?.length ? switchRt.rows : ctx.rowsRef.current || []
    let panelToRestore = cachedPanel || emptyThreadPanel()
    if (
      panelToRestore.clarification &&
      !findAskClarificationAwaitingUserInRows(switchRows)
    ) {
      panelToRestore = clearThreadPanelClarification(panelToRestore)
      ctx.threadPanelBySessionRef.current.set(selectedSessionKey, panelToRestore)
    }
    ctx.setThreadPanelState(panelToRestore)
    if (Array.isArray(panelToRestore.todos) && panelToRestore.todos.length > 0) {
      ctx.setHasReceivedTodos(true)
    }
  }
  ctx.setSessionMode(getSessionModeFromMeta(selectedSessionKey))
  ctx.setCollabOn(getSessionCollabModeFromMeta(selectedSessionKey))
  ctx.setModeMenuOpen(false)
  ctx.bumpStreamFullRef.current()

  const carriedDraft = ctx.pendingComposerDraftCarryRef.current
  if (carriedDraft !== null) {
    ctx.pendingComposerDraftCarryRef.current = null
    if (selectedSessionKey) {
      if (carriedDraft) ctx.composerDraftsRef.current.set(selectedSessionKey, carriedDraft)
      else ctx.composerDraftsRef.current.delete(selectedSessionKey)
    }
    ctx.restoreComposerDraft(carriedDraft)
  } else if (selectedSessionKey) {
    const draft = ctx.composerDraftsRef.current.get(selectedSessionKey) || ''
    ctx.restoreComposerDraft(draft)
  }

  // 工作空间历史由壳层 hydrateGlobalWorkspaceHistoryOnce 写入缓存；切换会话只读缓存
  try {
    const sessionCtx = ctx.getSessionContext(selectedSessionKey)
    const pendingWs = ctx.pendingNewSessionWorkspaceRef.current
    let wsRoot = String(sessionCtx.local_workspace_root || '').trim()
    if (
      pendingWs &&
      pendingWs.sessionKey === selectedSessionKey &&
      String(pendingWs.path || '').trim()
    ) {
      wsRoot = String(pendingWs.path).trim()
      ctx.pendingNewSessionWorkspaceRef.current = null
    }
    ctx.setLocalWorkspaceRoot(wsRoot)
    ctx.shellIntentWorkspaceRef.current = wsRoot || null
    if (!wsRoot) {
      // 智能体员工会话：context 未绑定 workspace 时，兜底取该员工绑定的 workspace_path
      const empCode = parseProactiveSessionKey(selectedSessionKey).agentCode
      if (empCode) {
        void (async () => {
          try {
            const { api } = await import('../../../lib/tauri-api.js')
            const res = await api.proactiveGetRole(empCode)
            const role = res?.role || res
            const cfg = role && typeof role === 'object' ? role.config : null
            const bound = String(
              (cfg && typeof cfg === 'object'
                ? (cfg as { workspace_path?: string }).workspace_path || ''
                : '') || '',
            ).trim()
            if (
              bound &&
              String(ctx.sessionRef.current || '').trim() === String(selectedSessionKey || '').trim()
            ) {
              ctx.setLocalWorkspaceRoot(bound)
              ctx.shellIntentWorkspaceRef.current = bound
            }
          } catch {
            /* best-effort */
          }
        })()
      }
    }
    const savedCtxFiles = Array.isArray(sessionCtx.context_files) ? sessionCtx.context_files : []
    ctx.setContextFiles(
      savedCtxFiles
        .filter(
          (f: unknown) =>
            f && typeof f === 'object' && String((f as ContextFileEntry).path || '').trim(),
        )
        .map((f: ContextFileEntry) => ({
          path: String(f.path).trim(),
          name: String(f.name || f.path).trim(),
        })),
    )
    ctx.setWorkspaceHistory(ctx.getWorkspaceHistory(selectedSessionKey))
    ctx.setGlobalWorkspaceHistory(ctx.getGlobalWorkspaceHistory())
  } catch {
    ctx.setLocalWorkspaceRoot('')
    ctx.setWorkspaceHistory([])
    ctx.setGlobalWorkspaceHistory([])
  }
}
