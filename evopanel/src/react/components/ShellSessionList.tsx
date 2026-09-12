import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'
import {
  ShellChevronIcon,
  ShellFolderPlusIcon,
  ShellPlusIcon,
  ShellRefreshIcon,
  ShellSearchIcon,
  ShellWorkspaceIcon,
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
  /** ``/api/agents``：员工会话行展示岗位头像 */
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

const EMPLOYEE_JOB_TITLE_FALLBACK = '未命名岗位'

/** 整组常量「智能体员工」不是具体岗位名，不能当员工下拉项文案 */
function isGenericEmployeeSidebarLabel(value: string): boolean {
  const t = String(value || '').trim()
  return !t || t === WORKSPACE_GROUP_PROACTIVE_LABEL || t === EMPLOYEE_JOB_TITLE_FALLBACK
}

/** 与 ShellSessionListRow 一致：忽略大小写，_/- 互通，避免匹配失败后露出英文 code */
function normalizeEmployeeCodeKey(code: string): string {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
}

/** 岗位名是否已塌成英文 agent_code（不能当标题） */
function isCollapsedJobTitle(title: string, agentCode: string): boolean {
  const name = String(title || '').trim()
  const code = String(agentCode || '').trim()
  if (!name) return true
  if (!code) return false
  return normalizeEmployeeCodeKey(name) === normalizeEmployeeCodeKey(code)
}

/**
 * 员工下拉 / 分组标题：永远只显示岗位名（role_name）。
 * 禁止 agent_name、禁止英文 agent_code、禁止整组常量「智能体员工」。
 */
function resolveEmployeeGroupLabel(
  agentCode: string,
  roles: Array<{ agent_code: string; role_name: string; agent_name?: string }> | null | undefined,
  fallback = '',
): string {
  const code = String(agentCode || '').trim()
  const codeKey = normalizeEmployeeCodeKey(code)
  const role = (roles || []).find(
    (r) => normalizeEmployeeCodeKey(r.agent_code) === codeKey,
  )
  const candidates = [role?.role_name, fallback]
  for (const raw of candidates) {
    const title = String(raw || '').trim()
    if (!title || isGenericEmployeeSidebarLabel(title)) continue
    if (isCollapsedJobTitle(title, code)) continue
    // 显式不用 agent_name：即使与岗位名相同，也只接受 role_name / 岗位 hint
    return title
  }
  return EMPLOYEE_JOB_TITLE_FALLBACK
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
  roles: Array<{ agent_code: string; role_name: string; agent_name?: string }> | null | undefined,
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
      label: resolveEmployeeGroupLabel(code, roles, labelHint),
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
    pushGroup(code, isGenericEmployeeSidebarLabel(wsLabel) ? '' : wsLabel)
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
}: ShellSessionListProps) {
  const [titleEditKey, setTitleEditKey] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  /** 点击「刷新会话列表」按钮后的刷新中状态（列表未变化时给可见反馈） */
  const [refreshing, setRefreshing] = useState(false)
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  /** chats = 普通对话；employees = 智能体员工会话 */
  const [listTab, setListTab] = useState<'chats' | 'employees'>('chats')
  const [focusedWorkspaceKey, setFocusedWorkspaceKey] = useState<string | null>(null)
  /** 员工 Tab：下拉选中的员工 code；空 = 全部员工 */
  const [focusedEmployeeCode, setFocusedEmployeeCode] = useState<string | null>(null)
  const [empMenuOpen, setEmpMenuOpen] = useState(false)
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

  const selectWorkspaceFilter = useCallback(
    (group: ShellWorkspaceGroup | null) => {
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

  /** 选中员工会话时对齐员工下拉 */
  useEffect(() => {
    if (!isEmployeesTab || !displaySelectedKey) return
    const code = proactiveAgentCodeFromSessionKey(displaySelectedKey)
    if (!code) return
    setFocusedEmployeeCode((prev) => {
      if (prev && prev.toLowerCase() === code.toLowerCase()) return prev
      return code
    })
  }, [isEmployeesTab, displaySelectedKey])

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
    let groups = buildEmployeeSidebarGroups(sessionOnly, effectiveEmployeeRoles)
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
    // 优先在当前筛选的工作空间内新建，避免全部落到「默认」
    if (focusedGroup) {
      const path =
        focusedGroup.workspaceKey === WORKSPACE_GROUP_UNBOUND
          ? null
          : resolveShellGroupWorkspacePath(focusedGroup, registeredWorkspacePaths)
      onNewSessionInWorkspace?.(path)
      return
    }
    const btn = document.getElementById('shell-btn-new-task')
    if (btn) {
      btn.click()
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
        <div className="react-chat-aside-history-head">
          <div className="react-chat-aside-segment" role="tablist" aria-label="会话类型">
            <button
              type="button"
              role="tab"
              aria-selected={listTab === 'chats'}
              className={`react-chat-aside-segment-btn${listTab === 'chats' ? ' is-active' : ''}`}
              onClick={() => setListTab('chats')}
            >
              普通对话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={listTab === 'employees'}
              className={`react-chat-aside-segment-btn${listTab === 'employees' ? ' is-active' : ''}`}
              onClick={() => {
                setListTab('employees')
                setFocusedWorkspaceKey(null)
                setWsMenuOpen(false)
              }}
            >
              员工对话
            </button>
          </div>
          <div className="react-chat-aside-history-actions">
            <button
              type="button"
              className={`react-chat-aside-history-icon-btn${refreshing ? ' is-refreshing' : ''}`}
              title={refreshing ? '正在刷新…' : '刷新会话列表'}
              aria-label={refreshing ? '正在刷新…' : '刷新会话列表'}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                setFilterOpen(false)
                void Promise.resolve(onRefreshSessionList())
                  .catch(() => {
                    /* 刷新失败也结束刷新态，避免按钮卡死 */
                  })
                  .finally(() => {
                    setRefreshing(false)
                  })
              }}
            >
              <ShellRefreshIcon size={15} />
            </button>
            <button
              type="button"
              className={`react-chat-aside-history-icon-btn${filterOpen ? ' is-active' : ''}`}
              title="搜索会话"
              aria-label="搜索会话"
              aria-pressed={filterOpen}
              onClick={() => {
                setFilterOpen((v) => {
                  const next = !v
                  if (!next) onSessionFilterChange('')
                  return next
                })
              }}
            >
              <ShellSearchIcon size={15} />
            </button>
            <button
              type="button"
              className="react-chat-aside-history-icon-btn"
              title={newSessionHint}
              aria-label={newSessionHint}
              onClick={handleNewSessionClick}
            >
              <ShellPlusIcon size={15} />
            </button>
          </div>
          <div className="react-chat-aside-history-search-wrap" hidden={!filterOpen}>
            <input
              ref={filterInputRef}
              type="search"
              className="react-chat-aside-history-search"
              id="shell-session-filter"
              placeholder={isEmployeesTab ? '搜索员工会话…' : '搜索会话…'}
              aria-label={isEmployeesTab ? '搜索员工会话' : '搜索会话'}
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
                {onNewWorkspace ? (
                  <button
                    type="button"
                    className="react-chat-aside-ws-menu-item react-chat-aside-ws-menu-item--add"
                    onClick={() => {
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
                {workspaceFilterOptions.map((g) => {
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
                <button
                  type="button"
                  role="option"
                  aria-selected={!focusedEmployeeCode}
                  className={`react-chat-aside-ws-menu-item${!focusedEmployeeCode ? ' is-active' : ''}`}
                  onClick={() => selectEmployeeFilter(null)}
                >
                  <span className="react-chat-aside-ws-menu-item-label">全部员工</span>
                </button>
                {employeeGroups.map((g) => {
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
              aria-label={isEmployeesTab ? '员工对话' : '普通对话'}
            >
              <ul className="react-chat-session-recent-list">
                {recentVisibleRows.map((row) => renderSessionRow(row))}
                {showDutyFold ? (
                  <li className="react-chat-session-duty-fold">
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
                ) : null}
                {showDutyFold && dutyFoldOpen
                  ? foldedDutyRows.map((row) => renderSessionRow(row))
                  : null}
                {flatLoading && !flatHasMore ? (
                  <li className="react-chat-muted react-chat-session-workspace-loading">
                    加载中…
                  </li>
                ) : null}
                {flatHasMore ? (
                  <li
                    className="react-chat-session-workspace-load-more-sentinel"
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
                ) : null}
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
