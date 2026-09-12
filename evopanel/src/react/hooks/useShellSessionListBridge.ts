import { useMemo, useRef, useEffect } from 'react'
import type { ChatSessionRow } from '../chat-types.js'
import { buildShellSidebarGroups } from '../lib/session-list/build-shell-rows.js'
import { GLOBAL_RECENT_PAGINATION_KEY } from '../lib/session-list/constants.js'
import {
  normalizeWorkspacePathKey,
  stabilizeShellWorkspaceGroupOrder,
} from '../lib/session-list/workspace-groups.js'
import type { ShellSessionListProps } from '../components/ShellSessionList.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { RunningSessionSummary } from './useRunningSessionSummaries.js'
import type { ShellWorkspaceGroup, WorkspaceGroupSummary } from '../lib/session-list/types.js'

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
  onNewWorkspace?: () => void
  onNewSessionInWorkspace?: (workspacePath: string | null) => void
  onDeleteWorkspace?: (group: ShellWorkspaceGroup) => void | Promise<void>
  onWorkspaceFocus?: (workspacePath: string | null) => void
  onOpenWorkspaceFolder?: (group: ShellWorkspaceGroup) => void | Promise<void>
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
  const folderOrderWrapper = useMemo(() => ({ current: [] as string[] }), [])

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
      folderOrderWrapper.current = folderOrderWrapper.current.filter(
        (k) => normalizeWorkspacePathKey(k) !== key,
      )
    }
    window.addEventListener('evopanel:shell-workspace-removed', onWorkspaceRemoved)
    return () => window.removeEventListener('evopanel:shell-workspace-removed', onWorkspaceRemoved)
  }, [folderOrderWrapper])

  const shellListProps = useMemo((): ShellSessionListProps => {
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
      registeredWorkspacePaths,
      employeeRoles,
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
  ])

  return { shellListProps }
}
