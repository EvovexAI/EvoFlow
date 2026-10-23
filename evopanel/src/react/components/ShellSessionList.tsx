import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Folder as FolderIcon, FolderOpen as FolderOpenIcon } from 'lucide-react'
import { getCurrentRoute, navigate } from '../../router.js'
import {
  mutateSessionPinned,
  persistPinnedOrderFromRows,
  renameSession,
  reorderPinnedRowsInPlace,
} from '../lib/session-list/session-list-mutations.js'
import { clearSessionPinPending } from '../lib/session-list/session-pin-pending.js'
import {
  loadExpandedWorkspaceKeys,
  saveExpandedWorkspaceKeys,
} from '../lib/session-list/expanded-workspaces-storage.js'
import {
  loadPinnedWorkspaceKeys,
  savePinnedWorkspaceKeys,
} from '../lib/session-list/pinned-workspaces-storage.js'
import type { ShellSidebarSyncRow, ShellWorkspaceGroup } from '../lib/session-list/types.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { RunningSessionSummary } from '../hooks/useRunningSessionSummaries.js'
import {
  ShellSessionListRow,
  SessionContextMenuPortal,
  clipSidebarSessionTitle,
} from './ShellSessionListRow.js'
import {
  WORKSPACE_GROUP_PROACTIVE,
  WORKSPACE_GROUP_PROACTIVE_LABEL,
  WORKSPACE_GROUP_UNBOUND,
  WORKSPACE_GROUP_VIRTUAL,
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
  proactiveAgentCodeFromSessionKey,
  resolveShellGroupWorkspacePath,
  splitVisibleAndFoldedDutySessions,
} from '../lib/session-list/workspace-groups.js'
import {
  isGenericEmployeeLabel,
  isCollapsedJobTitle,
  normalizeEmployeeCodeKey,
  resolveEmployeeDisplayName,
} from '../lib/employee-display.js'
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'
import {
  ShellChevronIcon,
  ShellFolderPlusIcon,
  ShellPlusIcon,
  ShellRefreshIcon,
  ShellWorkspaceIcon,
  ShellFilterIcon,
  ShellHashIcon,
  ShellFolderIcon,
} from './ShellSidebarIcons.js'
import {
  WorkspaceFolderContextMenuPortal,
  type WorkspaceFolderContextMenuState,
} from './WorkspaceFolderContextMenuPortal.js'

export type ShellSessionListProps = {
  listLoading: boolean
  sessionFilter: string
  moreMenuKey: string | null
  selectedSessionKey: string
  newTaskActive: boolean
  rows: ShellSidebarSyncRow[]
  groups: ShellWorkspaceGroup[]
  /** ``/api/agents``：员工会话行展示岗位头像 + 员工下拉做 agent_name 兜底。
   *  保持与子组件 (AssignedAgentAvatar / ShellSessionListRow) 一致的 unknown[] 类型。 */
  agents?: unknown[] | null
  runningSessionMap?: Record<string, RunningSessionSummary>
  resolveLiveStreamActivityForSession?: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null
  globalHasMore?: boolean
  globalLoading?: boolean
  onSelectSession: (sessionKey: string) => void
  /** Background warm idle runtime cache on sidebar hover. */
  onPrefetchSession?: (sessionKey: string) => void
  onSessionFilterChange: (value: string) => void
  onMoreMenuToggle: (sessionKey: string) => void
  onMoreMenuClose: () => void
  onDeleteSession: (sessionKey: string) => void
  onForkSession?: (sessionKey: string) => void
  onRefreshSession: (sessionKey: string) => void
  onRefreshSessionList: () => void | Promise<void>
  onStopSession: (sessionKey: string) => void
  onWorkspaceExpand?: (
    workspaceKey: string,
    opt?: { force?: boolean; silent?: boolean },
  ) => void
  onLoadMoreWorkspace?: (workspaceKey: string) => void
  onLoadMoreGlobal?: () => void
  onPinSession?: (sessionKey: string, pinned: boolean) => void
  onNewWorkspace?: () => void
  onNewSessionInWorkspace?: (workspacePath: string | null) => void
  onDeleteWorkspace?: (group: ShellWorkspaceGroup) => void | Promise<void>
  /** 用户点选工作空间时，供全局「新对话」继承该目录 */
  onWorkspaceFocus?: (workspacePath: string | null) => void
  onOpenWorkspaceFolder?: (group: ShellWorkspaceGroup) => void | Promise<void>
  registeredWorkspacePaths?: string[]
  /** 已雇佣员工花名册；员工 Tab 展示全员，即使尚无会话 */
  employeeRoles?: Array<{
    agent_code: string
    role_name: string
    agent_name?: string
    department?: string
    status?: string
  }> | null
  /** 进员工 Tab / 打开员工下拉时重拉花名册（platform hire 后父级可能仍是 mount 快照） */
  onRefreshEmployeeRoles?: () => void | Promise<void>
}

const SS_PENDING_SHELL_SESSION = 'evopanel_pending_shell_session'

function clearPendingShellSession(): void {
  try {
    sessionStorage.removeItem(SS_PENDING_SHELL_SESSION)
  } catch {
    /* ignore */
  }
}

function isChatHashRoute(): boolean {
  const p = (getCurrentRoute() || '/chat').split('?')[0]
  return p === '/chat' || p === '/chat-react'
}

function normalizePinKey(key: string): string {
  const raw = String(key || '').trim()
  if (!raw || isSpecialWorkspaceGroupKey(raw)) return raw
  return normalizeWorkspacePathKey(raw) || raw
}

/** 「智能体员工」整组常量在 proactive 会话上恒作为 workspaceLabel,不能当岗位名 hint。 */
function isGenericEmployeeWorkspaceLabel(value: string): boolean {
  return isGenericEmployeeLabel(value) || value === WORKSPACE_GROUP_PROACTIVE_LABEL
}

/**
 * 员工下拉 / 分组标题:优先岗位名(role_name);空时降级到 agent_name;
 * 都没有时显示英文 agent_code。绝不显示「未命名岗位」字面量。
 *
 * 详见 `../lib/employee-display.ts`。
 */
type EmployeeGroupRole = {
  agent_code: string
  role_name?: string | null
  agent_name?: string | null
}

/** ShellSessionList props 用的弱类型,兼容多种上游 sources(/api/agents 列表、proactive 列表 等)。 */
type EmployeeGroupSource = {
  agent_code?: string | null
  agent_name?: string | null
  role_name?: string | null
}

function resolveEmployeeGroupLabel(
  agentCode: string,
  roles: ReadonlyArray<EmployeeGroupSource> | null | undefined,
  agents: ReadonlyArray<unknown> | null | undefined,
  fallback = '',
): string {
  const resolved = resolveEmployeeDisplayName(agentCode, {
    roles,
    agents,
    agentNameHint: fallback,
  })
  if (resolved) return resolved
  const code = String(agentCode || '').trim()
  return code || ''
}

type EmployeeSidebarGroup = {
  agentCode: string
  label: string
  sessions: ShellSidebarSyncRow[]
  maxUpdatedAt: number
}

/** 员工 Tab：按 agent_code 折叠；花名册无会话也占一组 */
function buildEmployeeSidebarGroups(
  sessionRows: ShellSidebarSyncRow[],
  roles: ReadonlyArray<EmployeeGroupSource> | null | undefined,
  agents: ReadonlyArray<unknown> | null | undefined,
): EmployeeSidebarGroup[] {
  const sessionsByCode = new Map<string, ShellSidebarSyncRow[]>()
  for (const row of sessionRows) {
    const code = proactiveAgentCodeFromSessionKey(row.sessionKey)
    if (!code) continue
    const lc = normalizeEmployeeCodeKey(code)
    const list = sessionsByCode.get(lc) || []
    list.push(row)
    sessionsByCode.set(lc, list)
  }

  const out: EmployeeSidebarGroup[] = []
  const seen = new Set<string>()
  const list = Array.isArray(roles) ? roles : []

  const pushGroup = (code: string, labelHint = '') => {
    const lc = normalizeEmployeeCodeKey(code)
    if (!lc || seen.has(lc)) return
    seen.add(lc)
    const sessions = [...(sessionsByCode.get(lc) || [])].sort((a, b) => {
      const byUpdated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
      if (byUpdated !== 0) return byUpdated
      return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''))
    })
    const maxUpdatedAt = sessions.reduce((m, r) => Math.max(m, Number(r.updatedAt || 0)), 0)
    out.push({
      agentCode: code,
      label: resolveEmployeeGroupLabel(code, roles, agents, labelHint),
      sessions,
      maxUpdatedAt,
    })
  }

  for (const role of list) {
    const code = String(role.agent_code || '').trim()
    if (!code) continue
    pushGroup(code, String(role.role_name || '').trim())
  }
  for (const [lc, rowsForCode] of sessionsByCode) {
    if (seen.has(lc)) continue
    const code = proactiveAgentCodeFromSessionKey(rowsForCode[0]?.sessionKey) || lc
    // workspaceLabel 对 proactive 会话恒为「智能体员工」，不能当岗位名传入
    const wsLabel = String(rowsForCode[0]?.workspaceLabel || '').trim()
    pushGroup(code, isGenericEmployeeWorkspaceLabel(wsLabel) ? '' : wsLabel)
  }

  return out.sort((a, b) => {
    const byUpdated = Number(b.maxUpdatedAt || 0) - Number(a.maxUpdatedAt || 0)
    if (byUpdated !== 0) return byUpdated
    return a.label.localeCompare(b.label, 'zh-CN')
  })
}

export function ShellSessionList({
  listLoading,
  sessionFilter,
  moreMenuKey,
  selectedSessionKey,
  newTaskActive,
  rows,
  groups = [],
  agents = null,
  employeeRoles = null,
  runningSessionMap = {},
  resolveLiveStreamActivityForSession,
  globalHasMore = false,
  globalLoading = false,
  onSelectSession,
  onPrefetchSession,
  onSessionFilterChange,
  onMoreMenuToggle,
  onMoreMenuClose,
  onDeleteSession,
  onForkSession,
  onRefreshSession,
  onRefreshSessionList,
  onStopSession,
  onWorkspaceExpand,
  onLoadMoreWorkspace,
  onLoadMoreGlobal,
  onPinSession,
  onNewWorkspace,
  onNewSessionInWorkspace,
  onDeleteWorkspace,
  onWorkspaceFocus,
  onOpenWorkspaceFolder,
  registeredWorkspacePaths = [],
  onRefreshEmployeeRoles,
}: ShellSessionListProps) {
  const onRefreshEmployeeRolesRef = useRef(onRefreshEmployeeRoles)
  onRefreshEmployeeRolesRef.current = onRefreshEmployeeRoles
  const [titleEditKey, setTitleEditKey] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  /** 点击「刷新会话列表」按钮后的刷新中状态（列表未变化时给可见反馈） */
  const [refreshing, setRefreshing] = useState(false)
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  /** chats = 普通对话；employees = 智能体员工会话 */
  const [listTab, setListTab] = useState<'chats' | 'employees'>('chats')
  /** 视图切换：grouped = 分组视图（普通对话）；project = 项目视图（员工对话） */
  const [viewMode, setViewMode] = useState<'grouped' | 'project'>('grouped')

  // viewMode 和 listTab 联动
  useEffect(() => {
    setListTab(viewMode === 'grouped' ? 'chats' : 'employees')
  }, [viewMode])
  const [focusedWorkspaceKey, setFocusedWorkspaceKey] = useState<string | null>(null)
  /** 员工 Tab：下拉选中的员工 code；空 = 全部员工 */
  const [focusedEmployeeCode, setFocusedEmployeeCode] = useState<string | null>(null)
  const [empMenuOpen, setEmpMenuOpen] = useState(false)
  /** 工作空间下拉内的模糊搜索词（仅过滤下拉面板，不影响会话列表搜索） */
  const [wsMenuQuery, setWsMenuQuery] = useState('')
  /** 员工下拉内的模糊搜索词 */
  const [empMenuQuery, setEmpMenuQuery] = useState('')
  const [dutyFoldOpen, setDutyFoldOpen] = useState(false)
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    loadPinnedWorkspaceKeys(),
  )
  const [contextMenu, setContextMenu] = useState<{
    sessionKey: string
    x: number
    y: number
  } | null>(null)
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceFolderContextMenuState | null>(null)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() =>
    loadExpandedWorkspaceKeys(),
  )
  const listRef = useRef<HTMLUListElement>(null)
  const filterInputRef = useRef<HTMLInputElement>(null)
  const wsMenuRef = useRef<HTMLDivElement>(null)
  const empMenuRef = useRef<HTMLDivElement>(null)
  const wsMenuSearchRef = useRef<HTMLInputElement>(null)
  const empMenuSearchRef = useRef<HTMLInputElement>(null)
  const loadMoreLockRef = useRef<Record<string, boolean>>({})
  const autoTabForSessionRef = useRef('')
  const onWorkspaceExpandRef = useRef(onWorkspaceExpand)
  onWorkspaceExpandRef.current = onWorkspaceExpand

  const onChatRoute = isChatHashRoute()
  const displaySelectedKey = String(selectedSessionKey || '').trim()
  const isSearching = !!String(sessionFilter || '').trim()
  const isEmployeesTab = listTab === 'employees'

  /** 父级花名册为空时（启动竞态），员工 Tab 自行补拉岗位名 */
  const [localEmployeeRoles, setLocalEmployeeRoles] = useState<
    Array<{ agent_code: string; role_name: string; agent_name?: string }>
  >([])

  /** 切入员工 Tab：请父级重拉花名册（勿依赖 employeeRoles，否则会与 setState 循环） */
  useEffect(() => {
    if (!isEmployeesTab) return
    void onRefreshEmployeeRolesRef.current?.()
  }, [isEmployeesTab])

  useEffect(() => {
    if (!empMenuOpen) return
    void onRefreshEmployeeRolesRef.current?.()
  }, [empMenuOpen])

  useEffect(() => {
    if (!isEmployeesTab) return
    if (Array.isArray(employeeRoles) && employeeRoles.length > 0) return
    let cancelled = false
    void import('../../lib/tauri-api.js')
      .then(async ({ api, isGatewayWarming, waitForBackendReady }) => {
        if (typeof isGatewayWarming === 'function' && isGatewayWarming()) {
          await waitForBackendReady?.(90_000).catch(() => {})
        }
        return api.proactiveListRoles('active')
      })
      .then((res: { roles?: unknown[] } | unknown[]) => {
        if (cancelled) return
        const raw = Array.isArray(res)
          ? res
          : Array.isArray((res as { roles?: unknown[] })?.roles)
            ? (res as { roles: unknown[] }).roles
            : []
        const roles = raw
          .map((r: any) => ({
            agent_code: String(r?.agent_code || '').trim(),
            role_name: String(r?.role_name || '').trim(),
            agent_name: String(r?.agent_name || '').trim(),
          }))
          .filter((r) => r.agent_code)
        setLocalEmployeeRoles(roles)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isEmployeesTab, employeeRoles])

  useEffect(() => {
    const onEmployeesUpdated = () => {
      if (!isEmployeesTab) return
      if (Array.isArray(employeeRoles) && employeeRoles.length > 0) return
      void import('../../lib/tauri-api.js')
        .then(async ({ api }) => api.proactiveListRoles('active'))
        .then((res: { roles?: unknown[] } | unknown[]) => {
          const raw = Array.isArray(res)
            ? res
            : Array.isArray((res as { roles?: unknown[] })?.roles)
              ? (res as { roles: unknown[] }).roles
              : []
          const roles = raw
            .map((r: any) => ({
              agent_code: String(r?.agent_code || '').trim(),
              role_name: String(r?.role_name || '').trim(),
              agent_name: String(r?.agent_name || '').trim(),
            }))
            .filter((r) => r.agent_code)
          setLocalEmployeeRoles(roles)
        })
        .catch(() => {})
    }
    window.addEventListener('evopanel:employees-updated', onEmployeesUpdated)
    return () => window.removeEventListener('evopanel:employees-updated', onEmployeesUpdated)
  }, [isEmployeesTab, employeeRoles])

  const effectiveEmployeeRoles =
    Array.isArray(employeeRoles) && employeeRoles.length > 0
      ? employeeRoles
      : localEmployeeRoles

  useEffect(() => {
    setDutyFoldOpen(false)
  }, [isEmployeesTab, focusedEmployeeCode])

  /** 选中会话变化时对齐 Tab；不覆盖用户手动点 Tab */
  useEffect(() => {
    if (!displaySelectedKey) return
    if (autoTabForSessionRef.current === displaySelectedKey) return
    autoTabForSessionRef.current = displaySelectedKey
    const hit = rows.find((r) => String(r.sessionKey || '') === displaySelectedKey)
    if (!hit) return
    setListTab(hit.workspaceKey === WORKSPACE_GROUP_PROACTIVE ? 'employees' : 'chats')
  }, [displaySelectedKey, rows])

  /** 进入员工 Tab：已有数据则静默补拉，避免再亮一次底部 loading */
  useEffect(() => {
    if (!isEmployeesTab) return
    const hasProactive = rows.some((r) => r.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
    onWorkspaceExpandRef.current?.(WORKSPACE_GROUP_PROACTIVE, {
      force: true,
      silent: hasProactive,
    })
  }, [isEmployeesTab])

  /**
   * 员工对话：后台新建会话靠 panel:session_upserted / 切回前台补拉即可。
   * 不要 setInterval 轮询——会反复 soft merge + 把 offset 打回首页，
   * IntersectionObserver 再 loadMore，底部 sentinel 转圈 →「最后一个闪烁」。
   */
  useEffect(() => {
    if (!isEmployeesTab) return
    const reload = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      onWorkspaceExpandRef.current?.(WORKSPACE_GROUP_PROACTIVE, {
        force: true,
        silent: true,
      })
    }
    const onVis = () => {
      if (!document.hidden) reload()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [isEmployeesTab])

  const focusWorkspaceGroup = useCallback(
    (group: ShellWorkspaceGroup) => {
      if (isSpecialWorkspaceGroupKey(group.workspaceKey)) {
        onWorkspaceFocus?.(null)
        return
      }
      onWorkspaceFocus?.(resolveShellGroupWorkspacePath(group, registeredWorkspacePaths))
    },
    [onWorkspaceFocus, registeredWorkspacePaths],
  )

  const applyWorkspaceFocusFilter = useCallback(
    (group: ShellWorkspaceGroup | null) => {
      if (!group) {
        setFocusedWorkspaceKey(null)
        return
      }
      const key = normalizePinKey(group.workspaceKey)
      setFocusedWorkspaceKey(key)
      focusWorkspaceGroup(group)
      onWorkspaceExpand?.(key)
    },
    [focusWorkspaceGroup, onWorkspaceExpand],
  )

  const toggleWorkspacePinned = useCallback((workspaceKey: string) => {
    const key = normalizePinKey(workspaceKey)
    if (!key || isSpecialWorkspaceGroupKey(key)) return
    setPinnedWorkspaceKeys((prev) => {
      const exists = prev.some((k) => normalizePinKey(k) === key)
      const next = exists ? prev.filter((k) => normalizePinKey(k) !== key) : [...prev, key]
      savePinnedWorkspaceKeys(next)
      return next
    })
  }, [])

  const pinnedWorkspaceKeySet = useMemo(
    () => new Set(pinnedWorkspaceKeys.map((k) => normalizePinKey(k))),
    [pinnedWorkspaceKeys],
  )

  const focusedGroup = useMemo(() => {
    if (!focusedWorkspaceKey) return null
    const nk = normalizePinKey(focusedWorkspaceKey)
    return groups.find((g) => normalizePinKey(g.workspaceKey) === nk) || null
  }, [focusedWorkspaceKey, groups])

  /** 普通对话 Tab 下可选的工作空间（排除员工；含默认与已注册目录） */
  const workspaceFilterOptions = useMemo(() => {
    return groups.filter((g) => {
      if (g.workspaceKey === WORKSPACE_GROUP_PROACTIVE) return false
      if (g.workspaceKey === WORKSPACE_GROUP_VIRTUAL) return false
      return true
    })
  }, [groups])

  /** 下拉面板内的模糊匹配：忽略大小写，支持分隔符互通（与列表搜索口径一致） */
  const menuQueryHit = useCallback((query: string, ...fields: Array<string | null | undefined>) => {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return true
    const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[-_]/g, '')
    const nq = norm(q)
    return fields.some((f) => {
      const s = norm(f)
      return !!s && s.includes(nq)
    })
  }, [])

  /** 工作空间下拉：按 label / path 过滤（「添加」「全部」固定项不受影响） */
  const workspaceMenuOptions = useMemo(
    () => workspaceFilterOptions.filter((g) => menuQueryHit(wsMenuQuery, g.label, g.path, g.workspaceKey)),
    [workspaceFilterOptions, wsMenuQuery, menuQueryHit],
  )

  const selectWorkspaceFilter = useCallback(
    (group: ShellWorkspaceGroup | null) => {
      setWsMenuQuery('')
      if (!group) {
        setFocusedWorkspaceKey(null)
        onWorkspaceFocus?.(null)
        setWsMenuOpen(false)
        return
      }
      const key = normalizePinKey(group.workspaceKey)
      setFocusedWorkspaceKey(key)
      setListTab('chats')
      setWsMenuOpen(false)
      if (key === WORKSPACE_GROUP_UNBOUND) {
        onWorkspaceFocus?.(null)
      } else {
        focusWorkspaceGroup(group)
      }
      onWorkspaceExpand?.(key)
    },
    [focusWorkspaceGroup, onWorkspaceExpand, onWorkspaceFocus],
  )

  const workspaceFilterLabel = focusedGroup?.label || '全部工作空间'

  useEffect(() => {
    if (!wsMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (t && wsMenuRef.current?.contains(t)) return
      setWsMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWsMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [wsMenuOpen])

  /** 下拉面板开合：打开时聚焦搜索框（关闭时由 select* / 添加 等出口就地清词） */
  useEffect(() => {
    if (!wsMenuOpen) return
    const t = window.setTimeout(() => wsMenuSearchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [wsMenuOpen])

  useEffect(() => {
    if (!empMenuOpen) return
    const t = window.setTimeout(() => empMenuSearchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [empMenuOpen])

  useEffect(() => {
    const onExpandWorkspace = (ev: Event) => {
      const key = String(
        (ev as CustomEvent<{ workspaceKey?: string }>).detail?.workspaceKey || '',
      ).trim()
      if (!key) return
      const alreadyExpanded = expandedWorkspaces.has(key)
      setExpandedWorkspaces((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        saveExpandedWorkspaceKeys(next)
        return next
      })
      if (!alreadyExpanded) onWorkspaceExpand?.(key)
    }
    window.addEventListener('evopanel:shell-expand-workspace', onExpandWorkspace)
    return () => window.removeEventListener('evopanel:shell-expand-workspace', onExpandWorkspace)
  }, [expandedWorkspaces, onWorkspaceExpand])

  useEffect(() => {
    const btn = document.getElementById('shell-btn-new-task')
    if (!btn) return
    const na = !!newTaskActive && !displaySelectedKey
    btn.classList.toggle('active', na && onChatRoute)
  }, [newTaskActive, displaySelectedKey, onChatRoute])

  const handleSelect = useCallback(
    (sessionKey: string) => {
      const key = String(sessionKey || '').trim()
      if (!key) return
      clearPendingShellSession()
      document.getElementById('app-shell-aside')?.classList.remove('shell-aside-open')
      document.getElementById('shell-aside-overlay')?.classList.remove('visible')
      // 不在其它路由上立刻 select：宿主仍是 display:none，MessageVirtualList 会在 0 高度下 boot，
      // 回到 #/chat 后内容空白直到刷新。交给 chat-route-shown 再选一次。
      if (!isChatHashRoute()) {
        try {
          sessionStorage.setItem(SS_PENDING_SHELL_SESSION, key)
        } catch {
          /* ignore */
        }
        navigate('/chat')
        return
      }
      onSelectSession(key)
    },
    [onSelectSession],
  )

  const runMenuAction = useCallback(
    (action: 'pin' | 'rename' | 'stop' | 'delete' | 'fork' | 'refresh', sessionKey: string) => {
      const key = String(sessionKey || '').trim()
      if (!key) return
      setContextMenu(null)
      onMoreMenuClose()
      if (action === 'stop') {
        onStopSession(key)
        return
      }
      if (action === 'delete') {
        window.setTimeout(() => onDeleteSession(key), 0)
        return
      }
      if (action === 'fork') {
        window.setTimeout(() => onForkSession?.(key), 0)
        return
      }
      if (action === 'refresh') {
        onRefreshSession(key)
        return
      }
      if (action === 'rename') {
        setTitleEditKey(key)
        return
      }
      if (action === 'pin') {
        const row = rows.find((r) => String(r.sessionKey || '') === key)
        const nextPinned = !row?.isPinned
        onPinSession?.(key, nextPinned)
        void mutateSessionPinned(key, nextPinned).catch(() => {
          clearSessionPinPending(key)
          onPinSession?.(key, !nextPinned)
        })
      }
    },
    [onDeleteSession, onForkSession, onMoreMenuClose, onPinSession, onRefreshSession, onStopSession, rows],
  )

  const handleTitleCommit = useCallback(
    async (sessionKey: string, rawValue: string) => {
      const key = String(sessionKey || '').trim()
      const row = rows.find((r) => String(r.sessionKey || '') === key)
      const current = String(row?.title || '').trim()
      const title = clipSidebarSessionTitle(rawValue)
      setTitleEditKey('')
      if (!key || !title || title === current) return
      try {
        await renameSession(key, title)
      } catch {
        /* refresh 后恢复 */
      }
    },
    [rows],
  )

  const handlePinnedReorder = useCallback(
    (dragKey: string, dropKey: string) => {
      const nextRows = reorderPinnedRowsInPlace(rows, dragKey, dropKey)
      if (!nextRows) return
      void persistPinnedOrderFromRows(nextRows).catch(() => {})
    },
    [rows],
  )

  useEffect(() => {
    if (!filterOpen) return
    const t = window.setTimeout(() => filterInputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [filterOpen])

  useEffect(() => {
    if (sessionFilter) setFilterOpen(true)
  }, [sessionFilter])

  const triggerLoadMore = useCallback(
    (workspaceKey: string) => {
      const key = String(workspaceKey || '').trim()
      if (!key) return
      if (loadMoreLockRef.current[key]) return
      loadMoreLockRef.current[key] = true
      if (key === '__global__') onLoadMoreGlobal?.()
      else onLoadMoreWorkspace?.(key)
      window.setTimeout(() => {
        loadMoreLockRef.current[key] = false
      }, 400)
    },
    [onLoadMoreGlobal, onLoadMoreWorkspace],
  )

  const loadMoreKeys = useMemo(() => {
    if (isEmployeesTab) {
      const g = groups.find((x) => x.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
      return g?.hasMoreSessions ? [WORKSPACE_GROUP_PROACTIVE] : []
    }
    if (focusedWorkspaceKey) {
      const g = focusedGroup
      return g?.hasMoreSessions ? [g.workspaceKey] : []
    }
    return globalHasMore ? ['__global__'] : []
  }, [isEmployeesTab, focusedWorkspaceKey, focusedGroup, globalHasMore, groups])

  const loadMoreKeysSig = loadMoreKeys.join('\n')

  useEffect(() => {
    if (!loadMoreKeysSig) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const key = (entry.target as HTMLElement).dataset.workspaceKey
            if (key) triggerLoadMore(key)
          }
        }
      },
      { rootMargin: '80px' },
    )
    const sentinels = listRef.current?.querySelectorAll('[data-load-more-sentinel]')
    sentinels?.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [loadMoreKeysSig, triggerLoadMore])

  const workspaceContextGroup = workspaceContextMenu
    ? groups.find((g) => g.workspaceKey === workspaceContextMenu.workspaceKey) || null
    : null

  const contextRow = contextMenu
    ? rows.find((r) => String(r.sessionKey || '') === contextMenu.sessionKey) || null
    : null

  // 员工筛选只跟下拉手动选择走：保持「全部员工」时点进某会话不应改写筛选。

  useEffect(() => {
    if (!empMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (t && empMenuRef.current?.contains(t)) return
      setEmpMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEmpMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [empMenuOpen])

  const openNewEmployeeChat = useCallback(
    (agentCode: string) => {
      const code = String(agentCode || '').trim()
      if (!code) return
      const stamp = new Date().toISOString().replace(/[:/\\]/g, '-')
      const sk = `proactive:${code}:chat:${stamp}`
      clearPendingShellSession()
      try {
        sessionStorage.setItem(SS_PENDING_SHELL_SESSION, sk)
      } catch {
        /* ignore */
      }
      onSelectSession(sk)
    },
    [onSelectSession],
  )

  /** 员工 Tab：会话 ∪ 雇佣花名册 */
  const employeeGroups = useMemo(() => {
    if (!isEmployeesTab) return [] as EmployeeSidebarGroup[]
    const sessionOnly = rows.filter((r) => r.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
    let groups = buildEmployeeSidebarGroups(sessionOnly, effectiveEmployeeRoles, agents)
    const q = String(sessionFilter || '').trim().toLowerCase()
    if (q) {
      groups = groups
        .map((g) => {
          const code = g.agentCode.toLowerCase()
          const label = g.label.toLowerCase()
          const roleHit = (effectiveEmployeeRoles || []).some((role) => {
            if (String(role.agent_code || '').trim().toLowerCase() !== code) return false
            const an = String(role.agent_name || '').toLowerCase()
            const rn = String(role.role_name || '').toLowerCase()
            return an.includes(q) || rn.includes(q)
          })
          const groupHit = label.includes(q) || code.includes(q) || roleHit
          if (groupHit) return g
          const matchedSessions = g.sessions.filter((r) =>
            String(r.title || '')
              .toLowerCase()
              .includes(q),
          )
          if (matchedSessions.length === 0) return null
          return { ...g, sessions: matchedSessions }
        })
        .filter((g): g is EmployeeSidebarGroup => !!g)
    }
    return groups
  }, [isEmployeesTab, rows, effectiveEmployeeRoles, sessionFilter])

  const focusedEmployeeGroup = useMemo(() => {
    if (!focusedEmployeeCode) return null
    const lc = focusedEmployeeCode.toLowerCase()
    return employeeGroups.find((g) => g.agentCode.toLowerCase() === lc) || null
  }, [focusedEmployeeCode, employeeGroups])

  const employeeFilterLabel = focusedEmployeeGroup?.label || '全部员工'

  /** 员工下拉：按岗位名 / agent_code / 花名册姓名过滤（「全部员工」固定项不受影响） */
  const employeeMenuOptions = useMemo(() => {
    if (!String(empMenuQuery || '').trim()) return employeeGroups
    return employeeGroups.filter((g) => {
      const code = g.agentCode.toLowerCase()
      const roles = (effectiveEmployeeRoles || []).filter(
        (role) => String(role.agent_code || '').trim().toLowerCase() === code,
      )
      const roleFields = roles.flatMap((role) => [role.agent_name, role.role_name])
      return menuQueryHit(empMenuQuery, g.label, g.agentCode, ...roleFields)
    })
  }, [employeeGroups, empMenuQuery, effectiveEmployeeRoles, menuQueryHit])

  const employeeSessionRows = useMemo(() => {
    if (!isEmployeesTab) return [] as ShellSidebarSyncRow[]
    if (focusedEmployeeCode) {
      const lc = focusedEmployeeCode.toLowerCase()
      const g = employeeGroups.find((x) => x.agentCode.toLowerCase() === lc)
      return g?.sessions || []
    }
    // 全部员工：标题前缀员工名，避免多岗会话混在一起分不清
    return employeeGroups.flatMap((g) =>
      g.sessions.map((r) => ({
        ...r,
        title: `${g.label} · ${String(r.title || '').trim() || '会话'}`,
      })),
    )
  }, [isEmployeesTab, employeeGroups, focusedEmployeeCode])

  const pinnedRows = useMemo(() => {
    if (isEmployeesTab) {
      return employeeSessionRows
        .filter((r) => !!r.isPinned)
        .sort((a, b) => {
          const po = Number(a.pinOrder ?? 0) - Number(b.pinOrder ?? 0)
          if (po !== 0) return po
          return Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
        })
    }
    let list = rows
      .filter((r) => !!r.isPinned)
      .sort((a, b) => {
        const po = Number(a.pinOrder ?? 0) - Number(b.pinOrder ?? 0)
        if (po !== 0) return po
        return Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
      })
    list = list.filter((r) => r.workspaceKey !== WORKSPACE_GROUP_PROACTIVE)
    if (focusedWorkspaceKey) {
      const nk = normalizePinKey(focusedWorkspaceKey)
      list = list.filter((r) => normalizePinKey(r.workspaceKey) === nk)
    }
    return list
  }, [rows, focusedWorkspaceKey, isEmployeesTab, employeeSessionRows])

  const pinnedKeySet = useMemo(
    () => new Set(pinnedRows.map((r) => String(r.sessionKey || ''))),
    [pinnedRows],
  )

  const recentRows = useMemo(() => {
    if (isEmployeesTab) {
      return [...employeeSessionRows.filter((r) => !pinnedKeySet.has(String(r.sessionKey || '')))].sort(
        (a, b) => {
          const byUpdated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
          if (byUpdated !== 0) return byUpdated
          return String(a.sessionKey || '').localeCompare(String(b.sessionKey || ''))
        },
      )
    }
    let list = rows.filter((r) => !pinnedKeySet.has(String(r.sessionKey || '')))
    list = list.filter((r) => r.workspaceKey !== WORKSPACE_GROUP_PROACTIVE)
    if (focusedWorkspaceKey) {
      const nk = normalizePinKey(focusedWorkspaceKey)
      list = list.filter((r) => normalizePinKey(r.workspaceKey) === nk)
    }
    return [...list].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  }, [rows, pinnedKeySet, focusedWorkspaceKey, isEmployeesTab, employeeSessionRows])

  const selectEmployeeFilter = useCallback((code: string | null) => {
    setFocusedEmployeeCode(code ? String(code).trim() || null : null)
    setEmpMenuQuery('')
    setEmpMenuOpen(false)
    setDutyFoldOpen(false)
  }, [])

  const employeeDutySplit = useMemo(() => {
    if (!isEmployeesTab) return { visible: recentRows, folded: [] as ShellSidebarSyncRow[] }
    return splitVisibleAndFoldedDutySessions(recentRows, {
      selectedSessionKey: displaySelectedKey,
      expandAll: false,
    })
  }, [isEmployeesTab, recentRows, displaySelectedKey])
  const recentVisibleRows = isEmployeesTab && !isSearching
    ? employeeDutySplit.visible
    : recentRows
  const foldedDutyRows = employeeDutySplit.folded
  const showDutyFold = isEmployeesTab && !isSearching && foldedDutyRows.length > 0

  // 工作区分组树（对齐 ZCode WorkspaceSidebar）：多工作区时 recent 列表按组折叠显示，
  // 组头 = 图标 + 组名（员工 tab 用头像 + 员工名）+ 会话数；单组/聚焦组不折叠（保持原行为）。
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set())
  const groupedRecentSections = useMemo(() => {
    if (isEmployeesTab && focusedEmployeeCode) return null
    if (isEmployeesTab) {
      // 员工 tab：按 agent_code 分组，组头 = 员工头像 + 员工名
      const byCode = new Map<string, { label: string; rows: ShellSidebarSyncRow[] }>()
      for (const row of recentVisibleRows) {
        const code =
          proactiveAgentCodeFromSessionKey(row.sessionKey) ||
          String(row.workspaceKey || '').toLowerCase()
        if (!code) continue
        const entry = byCode.get(code) || { label: '', rows: [] }
        if (!entry.label) {
          entry.label = resolveEmployeeGroupLabel(code, effectiveEmployeeRoles, agents)
        }
        entry.rows.push(row)
        byCode.set(code, entry)
      }
      if (byCode.size <= 1) return null
      return Array.from(byCode.entries()).map(([key, value]) => ({
        key,
        label: value.label || key,
        rows: value.rows,
        avatarAgentCode: key,
      }))
    }
    if (focusedWorkspaceKey) return null
    if (groups.length <= 1) return null
    const byKey = new Map<string, { label: string; rows: ShellSidebarSyncRow[] }>()
    for (const row of recentVisibleRows) {
      const key = String(row.workspaceKey || '').trim() || '__unbound__'
      const label =
        groups.find((g) => g.workspaceKey === key)?.label ||
        String(row.workspaceLabel || '').trim() ||
        key
      const entry = byKey.get(key) || { label, rows: [] }
      entry.rows.push(row)
      byKey.set(key, entry)
    }
    if (byKey.size <= 1) return null
    return Array.from(byKey.entries()).map(([key, value]) => ({
      key,
      label: value.label,
      rows: value.rows,
      avatarAgentCode: null,
    }))
  }, [recentVisibleRows, isEmployeesTab, focusedEmployeeCode, focusedWorkspaceKey, groups, effectiveEmployeeRoles, agents])

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const renderSessionRow = (row: ShellSidebarSyncRow) => {
    const sk = String(row.sessionKey || '')
    const active = onChatRoute && sk === displaySelectedKey
    return (
      <ShellSessionListRow
        key={sk}
        row={row}
        active={active}
        moreOpen={moreMenuKey === sk}
        editingTitle={titleEditKey === sk}
        agents={agents}
        employeeRoles={effectiveEmployeeRoles}
        runningSummary={runningSessionMap[sk] ?? null}
        resolveLiveStreamActivity={resolveLiveStreamActivityForSession}
        variant="chat"
        onSelect={() => handleSelect(sk)}
        onMoreToggle={() => onMoreMenuToggle(sk)}
        onRefresh={() => onRefreshSession(sk)}
        onMenuAction={(action) => runMenuAction(action, sk)}
        onTitleCommit={(title) => void handleTitleCommit(sk, title)}
        onTitleCancel={() => setTitleEditKey('')}
        onStartTitleEdit={() => {
          setContextMenu(null)
          onMoreMenuClose()
          setTitleEditKey(sk)
        }}
        onContextMenu={(x, y) => {
          onMoreMenuClose()
          setContextMenu({ sessionKey: sk, x, y })
        }}
        onPinnedReorder={handlePinnedReorder}
        onPrefetch={
          active || !onPrefetchSession ? undefined : () => onPrefetchSession(sk)
        }
      />
    )
  }

  const flatHasMore = isEmployeesTab
    ? !!groups.find((g) => g.workspaceKey === WORKSPACE_GROUP_PROACTIVE)?.hasMoreSessions
    : focusedWorkspaceKey
      ? !!focusedGroup?.hasMoreSessions
      : globalHasMore
  const flatLoading = isEmployeesTab
    ? !!groups.find((g) => g.workspaceKey === WORKSPACE_GROUP_PROACTIVE)?.loadingSessions
    : focusedWorkspaceKey
      ? !!focusedGroup?.loadingSessions
      : globalLoading

  const handleNewSessionClick = useCallback(() => {
    setFilterOpen(false)
    onSessionFilterChange('')
    if (isEmployeesTab) {
      const code = String(focusedEmployeeCode || '').trim()
      if (!code) {
        setEmpMenuOpen(true)
        return
      }
      openNewEmployeeChat(code)
      return
    }
    // 一律走新建会话（即时切空白草稿），不要点侧栏「新建对话」——那会走 open-home，
    // 已在空工作台时只滚动不反馈，感觉像「点了没反应」。
    if (focusedGroup) {
      const path =
        focusedGroup.workspaceKey === WORKSPACE_GROUP_UNBOUND
          ? null
          : resolveShellGroupWorkspacePath(focusedGroup, registeredWorkspacePaths)
      onNewSessionInWorkspace?.(path)
      return
    }
    onNewSessionInWorkspace?.(null)
  }, [
    focusedGroup,
    focusedEmployeeCode,
    isEmployeesTab,
    onNewSessionInWorkspace,
    onSessionFilterChange,
    openNewEmployeeChat,
    registeredWorkspacePaths,
  ])

  const newSessionHint = isEmployeesTab
    ? focusedEmployeeCode
      ? `在「${employeeFilterLabel}」下新开对话`
      : '先选择员工，再新开对话'
    : focusedGroup
      ? focusedGroup.workspaceKey === WORKSPACE_GROUP_UNBOUND
        ? '在「默认」工作空间新建对话'
        : `在「${focusedGroup.label}」工作空间新建对话`
      : '新建对话（当前未筛选空间，将跟随现有上下文）'

  return (
    <>
      <div className="react-chat-aside-history">
        {/* ZCode 风格头部布局 - 单行 */}
        <div className="shell-view-header">
          {/* 视图切换 Tabs */}
          <div className="shell-view-tabs" role="tablist" aria-label="视图">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'grouped'}
              className={`shell-view-tab${viewMode === 'grouped' ? ' is-active' : ''}`}
              onClick={() => setViewMode('grouped')}
            >
              <ShellHashIcon size={12} />
              <span>任务</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'project'}
              className={`shell-view-tab${viewMode === 'project' ? ' is-active' : ''}`}
              onClick={() => setViewMode('project')}
            >
              <ShellFolderIcon size={12} />
              <span>员工</span>
            </button>
          </div>

          {/* 操作按钮 */}
          <div className="shell-view-actions">
            <button
              type="button"
              className={`shell-view-action-btn${filterOpen ? ' is-active' : ''}`}
              title="筛选和排序"
              aria-label="筛选和排序"
              aria-pressed={filterOpen}
              onClick={() => {
                setFilterOpen((v) => {
                  const next = !v
                  if (!next) onSessionFilterChange('')
                  return next
                })
              }}
            >
              <ShellFilterIcon size={14} />
            </button>
            <button
              type="button"
              className={`shell-view-action-btn${refreshing ? ' is-refreshing' : ''}`}
              title={refreshing ? '正在刷新…' : '刷新会话列表'}
              aria-label={refreshing ? '正在刷新…' : '刷新会话列表'}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                setFilterOpen(false)
                void Promise.resolve(onRefreshSessionList())
                  .catch(() => {})
                  .finally(() => {
                    setRefreshing(false)
                  })
              }}
            >
              <ShellRefreshIcon size={15} />
            </button>
            <button
              type="button"
              className="shell-view-action-btn"
              title={newSessionHint}
              aria-label={newSessionHint}
              onClick={handleNewSessionClick}
            >
              <ShellPlusIcon size={15} />
            </button>
          </div>

          {/* 搜索框 */}
          <div className="react-chat-aside-history-search-wrap" hidden={!filterOpen}>
            <input
              ref={filterInputRef}
              type="search"
              className="react-chat-aside-history-search"
              id="shell-session-filter"
              placeholder={isEmployeesTab ? '搜索员工…' : '搜索任务…'}
              aria-label={isEmployeesTab ? '搜索员工' : '搜索任务'}
              value={sessionFilter || ''}
              onChange={(e) => onSessionFilterChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFilterOpen(false)
                  onSessionFilterChange('')
                }
              }}
            />
          </div>
        </div>

        {!isEmployeesTab ? (
          <div className="react-chat-aside-ws-picker" ref={wsMenuRef}>
            <button
              type="button"
              className={`react-chat-aside-ws-trigger${wsMenuOpen ? ' is-open' : ''}${focusedWorkspaceKey ? ' has-filter' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={wsMenuOpen}
              title={focusedGroup?.path || workspaceFilterLabel}
              onClick={() => setWsMenuOpen((v) => !v)}
            >
              <ShellWorkspaceIcon size={14} className="react-chat-aside-ws-trigger-ic" />
              <span className="react-chat-aside-ws-trigger-label">{workspaceFilterLabel}</span>
              <ShellChevronIcon
                size={12}
                className={`react-chat-aside-ws-trigger-chevron${wsMenuOpen ? ' is-open' : ''}`}
              />
            </button>
            {wsMenuOpen ? (
              <div className="react-chat-aside-ws-menu" role="listbox" aria-label="选择工作空间">
                <div className="react-chat-aside-ws-menu-search">
                  <input
                    ref={wsMenuSearchRef}
                    type="search"
                    className="react-chat-aside-ws-menu-search-input"
                    placeholder="搜索工作空间…"
                    aria-label="搜索工作空间"
                    value={wsMenuQuery}
                    onChange={(e) => setWsMenuQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setWsMenuQuery('')
                      }
                    }}
                  />
                </div>
                {onNewWorkspace ? (
                  <button
                    type="button"
                    className="react-chat-aside-ws-menu-item react-chat-aside-ws-menu-item--add"
                    onClick={() => {
                      setWsMenuQuery('')
                      setWsMenuOpen(false)
                      onNewWorkspace()
                    }}
                  >
                    <ShellFolderPlusIcon size={14} />
                    <span className="react-chat-aside-ws-menu-item-label">添加工作空间</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={!focusedWorkspaceKey}
                  className={`react-chat-aside-ws-menu-item${!focusedWorkspaceKey ? ' is-active' : ''}`}
                  onClick={() => selectWorkspaceFilter(null)}
                >
                  <span className="react-chat-aside-ws-menu-item-label">全部工作空间</span>
                </button>
                {workspaceMenuOptions.map((g) => {
                  const active =
                    !!focusedWorkspaceKey &&
                    normalizePinKey(focusedWorkspaceKey) === normalizePinKey(g.workspaceKey)
                  return (
                    <button
                      key={g.workspaceKey}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`react-chat-aside-ws-menu-item${active ? ' is-active' : ''}`}
                      title={g.path || g.label}
                      onClick={() => selectWorkspaceFilter(g)}
                      onContextMenu={(e) => {
                        if (isSpecialWorkspaceGroupKey(g.workspaceKey)) return
                        e.preventDefault()
                        e.stopPropagation()
                        setContextMenu(null)
                        onMoreMenuClose()
                        setWsMenuQuery('')
                        setWsMenuOpen(false)
                        setWorkspaceContextMenu({
                          workspaceKey: g.workspaceKey,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }}
                    >
                      <span className="react-chat-aside-ws-menu-item-label">{g.label}</span>
                      {g.sessionCount > 0 ? (
                        <span className="react-chat-aside-ws-menu-item-count">{g.sessionCount}</span>
                      ) : null}
                    </button>
                  )
                })}
                {String(wsMenuQuery || '').trim() && workspaceMenuOptions.length === 0 ? (
                  <div className="react-chat-aside-ws-menu-empty">无匹配工作空间</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="react-chat-aside-ws-picker" ref={empMenuRef}>
            <button
              type="button"
              className={`react-chat-aside-ws-trigger${empMenuOpen ? ' is-open' : ''}${focusedEmployeeCode ? ' has-filter' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={empMenuOpen}
              title={focusedEmployeeGroup?.agentCode || employeeFilterLabel}
              onClick={() => setEmpMenuOpen((v) => !v)}
            >
              {focusedEmployeeCode ? (
                <AssignedAgentAvatar
                  agentCode={focusedEmployeeCode}
                  agents={agents}
                  size={16}
                  className="react-chat-aside-ws-trigger-ic"
                />
              ) : (
                <ShellWorkspaceIcon size={14} className="react-chat-aside-ws-trigger-ic" />
              )}
              <span className="react-chat-aside-ws-trigger-label">{employeeFilterLabel}</span>
              <ShellChevronIcon
                size={12}
                className={`react-chat-aside-ws-trigger-chevron${empMenuOpen ? ' is-open' : ''}`}
              />
            </button>
            {empMenuOpen ? (
              <div className="react-chat-aside-ws-menu" role="listbox" aria-label="选择员工">
                <div className="react-chat-aside-ws-menu-search">
                  <input
                    ref={empMenuSearchRef}
                    type="search"
                    className="react-chat-aside-ws-menu-search-input"
                    placeholder="搜索员工…"
                    aria-label="搜索员工"
                    value={empMenuQuery}
                    onChange={(e) => setEmpMenuQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEmpMenuQuery('')
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={!focusedEmployeeCode}
                  className={`react-chat-aside-ws-menu-item${!focusedEmployeeCode ? ' is-active' : ''}`}
                  onClick={() => selectEmployeeFilter(null)}
                >
                  <span className="react-chat-aside-ws-menu-item-label">全部员工</span>
                </button>
                {employeeMenuOptions.map((g) => {
                  const active =
                    !!focusedEmployeeCode &&
                    focusedEmployeeCode.toLowerCase() === g.agentCode.toLowerCase()
                  return (
                    <button
                      key={g.agentCode}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`react-chat-aside-ws-menu-item${active ? ' is-active' : ''}`}
                      title={g.agentCode}
                      onClick={() => selectEmployeeFilter(g.agentCode)}
                    >
                      <AssignedAgentAvatar
                        agentCode={g.agentCode}
                        agents={agents}
                        size={16}
                        className="react-chat-aside-ws-menu-item-avatar"
                      />
                      <span className="react-chat-aside-ws-menu-item-label">{g.label}</span>
                      {g.sessions.length > 0 ? (
                        <span className="react-chat-aside-ws-menu-item-count">{g.sessions.length}</span>
                      ) : null}
                    </button>
                  )
                })}
                {String(empMenuQuery || '').trim() && employeeMenuOptions.length === 0 ? (
                  <div className="react-chat-aside-ws-menu-empty">无匹配员工</div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <ul ref={listRef} className="react-chat-session-list" id="shell-session-list">
          {listLoading ? (
            <li className="react-chat-muted" style={{ padding: '10px 12px' }}>
              加载中…
            </li>
          ) : null}

          {!listLoading && pinnedRows.length === 0 && recentVisibleRows.length === 0 && !showDutyFold ? (
            <li className="react-chat-muted" style={{ padding: '10px 12px' }}>
              {isEmployeesTab
                ? isSearching
                  ? '无匹配会话'
                  : focusedEmployeeCode
                    ? '该员工暂无会话，点右上角 + 新开对话'
                    : (effectiveEmployeeRoles || []).length > 0
                      ? '暂无员工对话'
                      : '暂无已雇佣员工'
                : focusedWorkspaceKey
                  ? '此工作空间暂无会话'
                  : isSearching
                    ? '无匹配会话'
                    : '暂无会话'}
            </li>
          ) : null}

          {!listLoading && pinnedRows.length > 0 ? (
            <li className="react-chat-session-pinned-block" aria-label="固定会话">
              <ul className="react-chat-session-pinned-list">
                {pinnedRows.map((row) => renderSessionRow(row))}
              </ul>
            </li>
          ) : null}

          {!listLoading && (recentVisibleRows.length > 0 || showDutyFold || flatHasMore || flatLoading) ? (
            <li
              className="react-chat-session-recent-block"
              aria-label={isEmployeesTab ? '员工' : '任务'}
            >
              <ul className="react-chat-session-recent-list">
                {groupedRecentSections
                  ? groupedRecentSections.map((section) => {
                      const collapsed = collapsedGroupKeys.has(section.key)
                      return (
                        <li key={`ws-${section.key}`} className="react-chat-session-ws-group">
                          <button
                            type="button"
                            className="flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-start gap-2 rounded-lg border-none bg-transparent pl-2.5 pr-1 text-left outline-none hover:bg-transparent transition-colors"
                            aria-expanded={!collapsed}
                            onClick={() => toggleGroupCollapsed(section.key)}
                          >
                            <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                              {isEmployeesTab && section.avatarAgentCode ? (
                                <AssignedAgentAvatar
                                  agentCode={section.avatarAgentCode}
                                  agents={agents}
                                  size={14}
                                />
                              ) : collapsed ? (
                                <FolderIcon className="size-3.5 text-foreground-subtle" />
                              ) : (
                                <FolderOpenIcon className="size-3.5 text-foreground-subtle" />
                              )}
                            </span>
                            <span className="min-w-0 truncate text-xs text-foreground-subtle">
                              {section.label}
                            </span>
                          </button>
                          {!collapsed ? (
                              <ul className="react-chat-session-ws-group-list">
                                {section.rows.map((row) => renderSessionRow(row))}
                              </ul>
                            ) : null}
                        </li>
                      )
                    })
                  : [
                        recentVisibleRows.map((row) => renderSessionRow(row)),
                        showDutyFold ? (
                          <li className="react-chat-session-duty-fold" key="duty-fold">
                            <button
                              type="button"
                              className={`react-chat-session-duty-fold-btn${dutyFoldOpen ? ' is-open' : ''}`}
                              aria-expanded={dutyFoldOpen}
                              onClick={() => setDutyFoldOpen((v) => !v)}
                            >
                              <ShellChevronIcon
                                size={12}
                                className={`react-chat-session-duty-fold-chevron${dutyFoldOpen ? ' is-open' : ''}`}
                              />
                              <span>
                                {dutyFoldOpen
                                  ? '收起更早的值班记录'
                                  : `值班记录 · 还有 ${foldedDutyRows.length} 条`}
                              </span>
                            </button>
                          </li>
                        ) : null,
                        showDutyFold && dutyFoldOpen
                          ? foldedDutyRows.map((row) => (
                              <Fragment key={`duty-${row.sessionKey}`}>
                                {renderSessionRow(row)}
                              </Fragment>
                            ))
                          : null,
                        flatLoading && !flatHasMore ? (
                          <li className="react-chat-muted react-chat-session-workspace-loading" key="loading">
                            加载中…
                          </li>
                        ) : null,
                        flatHasMore ? (
                          <li
                            className="react-chat-session-workspace-load-more-sentinel"
                            key="load-more"
                            data-load-more-sentinel=""
                            data-workspace-key={
                              isEmployeesTab
                                ? WORKSPACE_GROUP_PROACTIVE
                                : focusedWorkspaceKey
                                  ? focusedGroup?.workspaceKey || focusedWorkspaceKey
                                  : '__global__'
                            }
                          >
                            {flatLoading ? (
                              <span className="react-chat-session-workspace-load-spinner" />
                            ) : null}
                          </li>
                        ) : null,
                      ]}
              </ul>
            </li>
          ) : null}
        </ul>
      </div>

      <SessionContextMenuPortal
        menu={contextMenu}
        row={contextRow}
        onClose={() => setContextMenu(null)}
        onAction={(action) => {
          if (contextMenu) runMenuAction(action, contextMenu.sessionKey)
        }}
      />
      <WorkspaceFolderContextMenuPortal
        menu={workspaceContextMenu}
        group={workspaceContextGroup}
        canOpenFolder={
          !!(
            workspaceContextGroup &&
            (resolveShellGroupWorkspacePath(workspaceContextGroup, registeredWorkspacePaths) ||
              workspaceContextGroup.workspaceKey === WORKSPACE_GROUP_UNBOUND)
          )
        }
        canPin={
          !!(
            workspaceContextGroup &&
            !isSpecialWorkspaceGroupKey(workspaceContextGroup.workspaceKey)
          )
        }
        isPinned={
          !!(
            workspaceContextGroup &&
            pinnedWorkspaceKeySet.has(normalizePinKey(workspaceContextGroup.workspaceKey))
          )
        }
        canFocus={
          !!(
            workspaceContextGroup &&
            !isSpecialWorkspaceGroupKey(workspaceContextGroup.workspaceKey)
          )
        }
        onClose={() => setWorkspaceContextMenu(null)}
        onOpenFolder={() => {
          const g = workspaceContextGroup
          setWorkspaceContextMenu(null)
          if (g) void onOpenWorkspaceFolder?.(g)
        }}
        onTogglePin={() => {
          const g = workspaceContextGroup
          setWorkspaceContextMenu(null)
          if (g) toggleWorkspacePinned(g.workspaceKey)
        }}
        onFocusOnly={() => {
          const g = workspaceContextGroup
          setWorkspaceContextMenu(null)
          if (g) applyWorkspaceFocusFilter(g)
        }}
        onDelete={() => {
          const g = workspaceContextGroup
          setWorkspaceContextMenu(null)
          if (g) {
            const nk = normalizePinKey(g.workspaceKey)
            setPinnedWorkspaceKeys((prev) => {
              const next = prev.filter((k) => normalizePinKey(k) !== nk)
              savePinnedWorkspaceKeys(next)
              return next
            })
            if (focusedWorkspaceKey && normalizePinKey(focusedWorkspaceKey) === nk) {
              setFocusedWorkspaceKey(null)
            }
            void onDeleteWorkspace?.(g)
          }
        }}
      />
    </>
  )
}
