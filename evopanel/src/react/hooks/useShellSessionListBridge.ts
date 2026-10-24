import { useMemo, useRef, useEffect, useState, useCallback, useSyncExternalStore } from 'react'
import type { ChatSessionRow } from '../chat-types.js'
import { buildShellSidebarGroups } from '../lib/session-list/build-shell-rows.js'
import { GLOBAL_RECENT_PAGINATION_KEY } from '../lib/session-list/constants.js'
import {
  normalizeWorkspacePathKey,
  stabilizeShellWorkspaceGroupOrder,
} from '../lib/session-list/workspace-groups.js'
import {
  didPanelSettingsLoadFromServer,
  getPanelSetting,
  patchPanelSettings,
} from '../../lib/panel-settings.js'
import {
  loadWorkspaceGroupOrder,
  saveWorkspaceGroupOrder,
} from '../lib/session-list/workspace-order-storage.js'
import type { ShellSessionListProps } from '../components/ShellSessionList.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { RunningSessionSummary } from './useRunningSessionSummaries.js'
import type { ShellWorkspaceGroup, WorkspaceGroupSummary } from '../lib/session-list/types.js'
import {
  getExecutingListRuntimeEpoch,
  subscribeExecutingListRuntime,
} from '../lib/session-runtime-store.js'
import {
  getSessionExecutionProbeEpoch,
  subscribeSessionExecutionProbes,
} from '../lib/session-execution/probe-cache.js'
import {
  getSessionGoalStateEpoch,
  subscribeSessionGoalState,
} from '../lib/session-execution/goal-mode-state.js'

export type UseShellSessionListBridgeOptions = {
  filteredSessions: ChatSessionRow[]
  sessions: ChatSessionRow[]
  workspaceSummaries: WorkspaceGroupSummary[]
  workspacePagination: Record<string, { hasMore: boolean; loading: boolean }>
  listLoading: boolean
  sessionFilter: string
  moreMenuKey: string | null
  selectedSessionKey: string
  newChatButtonActive: boolean
  sessionNamesTick: number
  /** ``/api/agents`` 列表，供侧栏员工会话显示岗位头像 */
  agents?: unknown[] | null
  runningSessionMap: Record<string, RunningSessionSummary>
  resolveLiveStreamActivityForSession: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null
  setSessionFilter: (value: string) => void
  setMoreMenuKey: (key: string | null | ((cur: string | null) => string | null)) => void
  onPinSession?: (sessionKey: string, pinned: boolean) => void
  onDeleteSession: (sessionKey: string) => void | Promise<void>
  onForkSession?: (sessionKey: string) => void | Promise<void>
  onRefreshSession: (sessionKey: string) => void | Promise<void>
  onRefreshSessionList: () => void | Promise<void>
  onStopSession: (sessionKey: string) => void | Promise<void>
  ensureWorkspaceExpanded: (
    workspaceKey: string,
    opt?: { force?: boolean; silent?: boolean },
  ) => void
  loadMoreWorkspaceSessions: (workspaceKey: string) => void | Promise<void>
  loadMoreGlobalRecentSessions?: () => void | Promise<void>
  onSelectSession: (sessionKey: string) => void
  onPrefetchSession?: (sessionKey: string) => void
  registeredWorkspacePaths?: string[]
  /** 已雇佣智能体员工（active），供「员工对话」Tab 展示完整花名册 */
  employeeRoles?: Array<{
    agent_code: string
    role_name: string
    agent_name?: string
    department?: string
    status?: string
  }> | null
  onRefreshEmployeeRoles?: () => void | Promise<void>
  onNewWorkspace?: () => void
  onNewSessionInWorkspace?: (workspacePath: string | null) => void
  onDeleteWorkspace?: (group: ShellWorkspaceGroup) => void | Promise<void>
  onWorkspaceFocus?: (workspacePath: string | null) => void
  onOpenWorkspaceFolder?: (group: ShellWorkspaceGroup) => void | Promise<void>
  /** 拖拽工作区分组头后按目标组换序（任务 Tab） */
  onReorderWorkspaceGroups?: (fromWorkspaceKey: string, toWorkspaceKey: string) => void
}

export function useShellSessionListBridge(opts: UseShellSessionListBridgeOptions) {
  const {
    filteredSessions,
    workspaceSummaries,
    workspacePagination,
    listLoading,
    sessionFilter,
    moreMenuKey,
    selectedSessionKey,
    newChatButtonActive,
    sessionNamesTick,
    agents = null,
    runningSessionMap,
    resolveLiveStreamActivityForSession,
    setSessionFilter,
    setMoreMenuKey,
    onDeleteSession,
    onForkSession,
    onRefreshSession,
    onRefreshSessionList,
    onStopSession,
    ensureWorkspaceExpanded,
    loadMoreWorkspaceSessions,
    loadMoreGlobalRecentSessions,
    onPinSession,
    onSelectSession,
    onPrefetchSession,
    registeredWorkspacePaths,
    employeeRoles = null,
    onRefreshEmployeeRoles,
    onNewWorkspace,
    onNewSessionInWorkspace,
    onDeleteWorkspace,
    onWorkspaceFocus,
    onOpenWorkspaceFolder,
  } = opts

  const onNewWorkspaceRef = useRef(onNewWorkspace)
  const onNewSessionInWorkspaceRef = useRef(onNewSessionInWorkspace)
  const onDeleteWorkspaceRef = useRef(onDeleteWorkspace)
  const onWorkspaceFocusRef = useRef(onWorkspaceFocus)
  const onOpenWorkspaceFolderRef = useRef(onOpenWorkspaceFolder)

  const onSelectSessionRef = useRef(onSelectSession)
  const onPrefetchSessionRef = useRef(onPrefetchSession)
  const onPinSessionRef = useRef(onPinSession)

  const ensureWorkspaceExpandedRef = useRef(ensureWorkspaceExpanded)
  const loadMoreWorkspaceSessionsRef = useRef(loadMoreWorkspaceSessions)
  const loadMoreGlobalRecentSessionsRef = useRef(loadMoreGlobalRecentSessions)
  // 工作区手动排序：创建时同步从 localStorage 恢复（不能用 effect 恢复——
  // effect 晚于首帧渲染，stabilize 会先用默认顺序填充 wrapper，随后 memo 的
  // 持久化把这份默认顺序写回 localStorage，覆盖用户拖拽保存的顺序）。
  const folderOrderWrapper = useMemo(
    () => ({ current: loadWorkspaceGroupOrder() }),
    [],
  )

  // reorder 后 bump 触发 shellListProps 重算（顺序已同步可用，无需异步 seed）
  const [workspaceOrderTick, bumpWorkspaceOrderTick] = useState(0)

  // 工作区手动排序：SQLite panel.ui（shellWorkspaceGroupOrder）为事实源，
  // localStorage 仅作冷启动首帧缓存。挂载后用户一旦拖过，本地即最新，
  // 后端加载完成的回包不再反向覆盖。
  const localOrderDirtyRef = useRef(false)

  const persistWorkspaceOrderRemote = useCallback(
    (order: string[]) => {
      void patchPanelSettings(
        { shellWorkspaceGroupOrder: order } as unknown as Record<string, unknown>,
        { silent: true },
      ).catch(() => undefined)
    },
    [],
  )

  const reorderWorkspaceGroups = useCallback(
    (fromKey: string, toKey: string) => {
      const from = normalizeWorkspacePathKey(fromKey)
      const to = normalizeWorkspacePathKey(toKey)
      if (!from || !to || from === to) return
      const cur = folderOrderWrapper.current
      const fi = cur.findIndex((k) => normalizeWorkspacePathKey(k) === from)
      const ti = cur.findIndex((k) => normalizeWorkspacePathKey(k) === to)
      if (fi < 0 || ti < 0) return
      const next = [...cur]
      const [item] = next.splice(fi, 1)
      next.splice(ti, 0, item)
      folderOrderWrapper.current = next
      saveWorkspaceGroupOrder(next)
      localOrderDirtyRef.current = true
      persistWorkspaceOrderRemote(next)
      bumpWorkspaceOrderTick((v) => v + 1)
    },
    [folderOrderWrapper, persistWorkspaceOrderRemote],
  )

  // 后端 panel.ui 加载完成后以服务端顺序为准（本地没拖过时）；远端为空则把本地顺序迁移上去
  useEffect(() => {
    let cancelled = false
    const applyRemoteOrder = () => {
      if (cancelled || localOrderDirtyRef.current) return
      const remote = getPanelSetting('shellWorkspaceGroupOrder')
      if (Array.isArray(remote) && remote.length > 0) {
        const next = remote
          .map((k) => String(k || '').trim())
          .filter(Boolean)
        if (
          next.length > 0 &&
          JSON.stringify(next) !== JSON.stringify(folderOrderWrapper.current)
        ) {
          folderOrderWrapper.current = next
          saveWorkspaceGroupOrder(next)
          bumpWorkspaceOrderTick((v) => v + 1)
        }
      } else if (folderOrderWrapper.current.length > 0) {
        persistWorkspaceOrderRemote([...folderOrderWrapper.current])
      }
    }
    if (didPanelSettingsLoadFromServer()) applyRemoteOrder()
    window.addEventListener('evopanel:panel-settings-loaded', applyRemoteOrder)
    return () => {
      cancelled = true
      window.removeEventListener('evopanel:panel-settings-loaded', applyRemoteOrder)
    }
  }, [folderOrderWrapper, persistWorkspaceOrderRemote])

  // Sync callback refs in a single effect to avoid react-hooks/refs violations
  useEffect(() => {
    onNewWorkspaceRef.current = onNewWorkspace
    onNewSessionInWorkspaceRef.current = onNewSessionInWorkspace
    onDeleteWorkspaceRef.current = onDeleteWorkspace
    onWorkspaceFocusRef.current = onWorkspaceFocus
    onOpenWorkspaceFolderRef.current = onOpenWorkspaceFolder
    onSelectSessionRef.current = onSelectSession
    onPrefetchSessionRef.current = onPrefetchSession
    onPinSessionRef.current = onPinSession
    ensureWorkspaceExpandedRef.current = ensureWorkspaceExpanded
    loadMoreWorkspaceSessionsRef.current = loadMoreWorkspaceSessions
    loadMoreGlobalRecentSessionsRef.current = loadMoreGlobalRecentSessions
  })

  useEffect(() => {
    const onWorkspaceRemoved = (ev: Event) => {
      const raw = String(
        (ev as CustomEvent<{ workspaceKey?: string }>).detail?.workspaceKey || '',
      ).trim()
      const key = normalizeWorkspacePathKey(raw) || raw
      if (!key) return
      const next = folderOrderWrapper.current.filter(
        (k) => normalizeWorkspacePathKey(k) !== key,
      )
      if (next.length === folderOrderWrapper.current.length) return
      folderOrderWrapper.current = next
      saveWorkspaceGroupOrder(next)
      localOrderDirtyRef.current = true
      persistWorkspaceOrderRemote(next)
    }
    window.addEventListener('evopanel:shell-workspace-removed', onWorkspaceRemoved)
    return () => window.removeEventListener('evopanel:shell-workspace-removed', onWorkspaceRemoved)
  }, [folderOrderWrapper, persistWorkspaceOrderRemote])

  // 与 Composer 停止按钮 / selectedTurnBusy 同源：isSessionExecuting 依赖这些 epoch。
  // ShellSessionListHost 被 memo，父级 epoch 变化若未进 props 不会重绘；必须在此订阅，
  // 否则右下角已停、左侧齿轮仍转。
  const executingListEpoch = useSyncExternalStore(
    subscribeExecutingListRuntime,
    getExecutingListRuntimeEpoch,
  )
  const executionProbeEpoch = useSyncExternalStore(
    subscribeSessionExecutionProbes,
    getSessionExecutionProbeEpoch,
  )
  const goalStateEpoch = useSyncExternalStore(subscribeSessionGoalState, getSessionGoalStateEpoch)

  const shellListProps = useMemo((): ShellSessionListProps => {
    void executingListEpoch
    void executionProbeEpoch
    void goalStateEpoch
    void workspaceOrderTick
    const sel = String(selectedSessionKey || '').trim()
    const built = buildShellSidebarGroups({
      filteredSessions,
      selectedSessionKey: sel,
      runningSessionMap,
      resolveLiveStreamActivityForSession,
      registeredWorkspacePaths,
      workspaceSummaries,
      workspacePagination,
    })
    const groups =
      workspaceSummaries.length > 0 || !listLoading
        ? stabilizeShellWorkspaceGroupOrder(built, folderOrderWrapper)
        : built
    // 新注册工作区已被 stabilize 追加进顺序，同步持久化（幂等写；
    // wrapper 在创建时已同步恢复，此处写入的始终是用户意图的顺序）
    if (folderOrderWrapper.current.length > 0) {
      saveWorkspaceGroupOrder(folderOrderWrapper.current)
    }
    const rows = groups.flatMap((g) => g.sessions)
    const globalPag = workspacePagination[GLOBAL_RECENT_PAGINATION_KEY]
    return {
      listLoading,
      sessionFilter,
      moreMenuKey,
      selectedSessionKey: sel,
      newTaskActive: !!newChatButtonActive,
      rows,
      groups,
      agents,
      runningSessionMap,
      resolveLiveStreamActivityForSession,
      globalHasMore: !!globalPag?.hasMore,
      globalLoading: !!globalPag?.loading,
      onSelectSession: (key) => onSelectSessionRef.current(key),
      // Always expose a stable wrapper — gate on ref at call time, not memo build time
      // (otherwise first paint without callback can permanently drop hover prefetch).
      onPrefetchSession: (key) => {
        onPrefetchSessionRef.current?.(key)
      },
      onSessionFilterChange: (value) => setSessionFilter(value),
      onMoreMenuToggle: (key) => setMoreMenuKey((cur) => (cur === key ? null : key)),
      onMoreMenuClose: () => setMoreMenuKey(null),
      onDeleteSession: (key) => void onDeleteSession(key),
      onForkSession: onForkSession ? (key) => void onForkSession(key) : undefined,
      onRefreshSession: (key) => void onRefreshSession(key),
      onRefreshSessionList: () => onRefreshSessionList(),
      onStopSession: (key) => void onStopSession(key),
      onWorkspaceExpand: (key, opt) => ensureWorkspaceExpandedRef.current(key, opt),
      onLoadMoreWorkspace: (key) => void loadMoreWorkspaceSessionsRef.current(key),
      onLoadMoreGlobal: () => void loadMoreGlobalRecentSessionsRef.current?.(),
      onPinSession: (key, pinned) => void onPinSessionRef.current?.(key, pinned),
      onNewWorkspace: () => void onNewWorkspaceRef.current?.(),
      onNewSessionInWorkspace: (path) => void onNewSessionInWorkspaceRef.current?.(path),
      onDeleteWorkspace: (group) => void onDeleteWorkspaceRef.current?.(group),
      onWorkspaceFocus: (path) => void onWorkspaceFocusRef.current?.(path),
      onOpenWorkspaceFolder: (group) => void onOpenWorkspaceFolderRef.current?.(group),
      onReorderWorkspaceGroups: reorderWorkspaceGroups,
      registeredWorkspacePaths,
      employeeRoles,
      onRefreshEmployeeRoles,
    }
  }, [
    filteredSessions,
    workspaceSummaries,
    workspacePagination,
    listLoading,
    sessionFilter,
    moreMenuKey,
    selectedSessionKey,
    newChatButtonActive,
    sessionNamesTick,
    agents,
    employeeRoles,
    onRefreshEmployeeRoles,
    runningSessionMap,
    resolveLiveStreamActivityForSession,
    setSessionFilter,
    setMoreMenuKey,
    onDeleteSession,
    onForkSession,
    onRefreshSession,
    onRefreshSessionList,
    onStopSession,
    ensureWorkspaceExpanded,
    loadMoreWorkspaceSessions,
    loadMoreGlobalRecentSessions,
    registeredWorkspacePaths,
    onNewWorkspace,
    onNewSessionInWorkspace,
    onWorkspaceFocus,
    onOpenWorkspaceFolder,
    folderOrderWrapper,
    reorderWorkspaceGroups,
    workspaceOrderTick,
    executingListEpoch,
    executionProbeEpoch,
    goalStateEpoch,
  ])

  return { shellListProps }
}
