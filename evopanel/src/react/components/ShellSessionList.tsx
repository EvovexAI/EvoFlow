import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Folder as FolderIcon, FolderOpen as FolderOpenIcon, Ellipsis, Plus } from 'lucide-react'
import { getCurrentRoute, navigate } from '../../router.js'
import { toast } from '../../components/toast.js'
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
  loadArchivedSessionKeys,
  setSessionArchived,
  topSessionInWorkspace,
  removeToppedSession,
  loadToppedSessionOrder,
  type ToppedSessionOrder,
} from '../lib/session-list/archived-sessions-storage.js'
import {
  loadUnreadMarkedKeys,
  markSessionUnread,
} from '../lib/session-list/unread-marked-storage.js'
import {
  loadPinnedWorkspaceKeys,
  savePinnedWorkspaceKeys,
} from '../lib/session-list/pinned-workspaces-storage.js'
import {
  loadFocusedEmployeeCode,
  loadShellSidebarViewMode,
  saveFocusedEmployeeCode,
  saveShellSidebarViewMode,
} from '../lib/session-list/shell-sidebar-chrome-storage.js'
import type { ShellSidebarSyncRow, ShellWorkspaceGroup } from '../lib/session-list/types.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { RunningSessionSummary } from '../hooks/useRunningSessionSummaries.js'
import {
  ShellSessionListRow,
  SessionContextMenuPortal,
  clipSidebarSessionTitle,
  type SessionMenuAction,
  type SessionMoveTarget,
} from './ShellSessionListRow.js'
import {
  WORKSPACE_GROUP_PROACTIVE,
  WORKSPACE_GROUP_PROACTIVE_LABEL,
  WORKSPACE_GROUP_UNBOUND,
  WORKSPACE_GROUP_VIRTUAL,
  isProactiveSessionKey,
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
  employeeOwnerCodeFromSession,
  proactiveAgentCodeFromSessionKey,
  resolveShellGroupWorkspacePath,
  splitVisibleAndFoldedDutySessions,
} from '../lib/session-list/workspace-groups.js'
import { buildWorkspaceRecentSections } from '../lib/session-list/recent-sections.js'
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
  ShellRefreshIcon,
  ShellWorkspaceIcon,
  ShellHashIcon,
  ShellFolderIcon,
  ShellEmployeesIcon,
  ShellDeptsIcon,
} from './ShellSidebarIcons.js'
import {
  deptChatSessionKey,
  deptIdFromSessionKey,
  getCachedDeptList,
  loadDeptChatList,
  prefetchDeptChatList,
  getDeptChatMeta,
  isDeptChatSessionKey,
  rememberDeptChatMeta,
  type DeptChatMeta,
} from '../lib/dept-chat-session.js'
import {
  WorkspaceFolderContextMenuPortal,
  type WorkspaceFolderContextMenuState,
} from './WorkspaceFolderContextMenuPortal.js'
import {
  EmployeeGroupContextMenuPortal,
  type EmployeeGroupContextMenuState,
} from './EmployeeGroupContextMenuPortal.js'
import {
  applyEmployeeGroupOrder,
  compareEmployeeRoster,
  employeeRosterOrderKeys,
  loadEmployeeGroupOrder,
  reorderEmployeeGroupKeys,
  saveEmployeeGroupOrder,
} from '../lib/session-list/employee-group-order-storage.js'

/** 置顶区折叠阈值（对齐 zcode WorkspacePinnedTasksSection collapsedLimit=20） */
const PINNED_COLLAPSED_LIMIT = 20

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
  /** 拖拽工作区分组头换序（对齐 zcode 侧栏工作区拖拽；顺序持久化在 bridge） */
  onReorderWorkspaceGroups?: (fromWorkspaceKey: string, toWorkspaceKey: string) => void
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
/** 侧栏 mint 的空草稿 sessionKey；主对话据此首帧就居中输入，避免贴底再跳。 */
export const SS_SHELL_EMPTY_DRAFT = 'evopanel_shell_empty_draft'

function clearPendingShellSession(): void {
  try {
    sessionStorage.removeItem(SS_PENDING_SHELL_SESSION)
  } catch {
    /* ignore */
  }
}

function markShellEmptyDraft(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  try {
    sessionStorage.setItem(SS_SHELL_EMPTY_DRAFT, sk)
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
 * 员工下拉 / 分组标题:优先 agent_name;空时兜底 role_name;
 * 都没有时显示英文 agent_code。
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
  department?: string | null
  status?: string | null
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

/** 员工 Tab：按 agent_code 折叠；花名册无会话也占一组。
 *  组头顺序 = 编制序（部门→启用态→名），不按会话活跃重排；组内会话仍按最近更新。 */
function buildEmployeeSidebarGroups(
  sessionRows: ShellSidebarSyncRow[],
  roles: ReadonlyArray<EmployeeGroupSource> | null | undefined,
  agents: ReadonlyArray<unknown> | null | undefined,
): EmployeeSidebarGroup[] {
  const sessionsByCode = new Map<string, ShellSidebarSyncRow[]>()
  for (const row of sessionRows) {
    // 归属看 agent_id（及 channel），不是只拆 session_key
    const code = employeeOwnerCodeFromSession(row)
    if (!code) continue
    const lc = normalizeEmployeeCodeKey(code)
    const list = sessionsByCode.get(lc) || []
    list.push(row)
    sessionsByCode.set(lc, list)
  }

  const out: EmployeeSidebarGroup[] = []
  const seen = new Set<string>()
  const list = [...(Array.isArray(roles) ? roles : [])].sort(compareEmployeeRoster)

  const pushGroup = (code: string, labelHint = '') => {
    const lc = normalizeEmployeeCodeKey(code)
    if (!lc || seen.has(lc)) return
    seen.add(lc)
    // 会话层：最近更新往上（置顶区在外层 pinnedRows 另算；值班折叠在 duty split）
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
  // 花名册外孤儿会话：固定沉底，按显示名排，不因活跃插队
  const orphans: { code: string; labelHint: string; label: string }[] = []
  for (const [lc, rowsForCode] of sessionsByCode) {
    if (seen.has(lc)) continue
    const code = employeeOwnerCodeFromSession(rowsForCode[0]) || lc
    // workspaceLabel 对 proactive 会话恒为「智能体员工」，不能当岗位名传入
    const wsLabel = String(rowsForCode[0]?.workspaceLabel || '').trim()
    const labelHint = isGenericEmployeeWorkspaceLabel(wsLabel) ? '' : wsLabel
    orphans.push({
      code,
      labelHint,
      label: resolveEmployeeGroupLabel(code, roles, agents, labelHint),
    })
  }
  orphans.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  for (const o of orphans) pushGroup(o.code, o.labelHint)

  return out
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
  onReorderWorkspaceGroups,
  registeredWorkspacePaths = [],
  onRefreshEmployeeRoles,
}: ShellSessionListProps) {
  const onRefreshEmployeeRolesRef = useRef(onRefreshEmployeeRoles)
  onRefreshEmployeeRolesRef.current = onRefreshEmployeeRoles
  const [titleEditKey, setTitleEditKey] = useState('')
  /** 点击「刷新会话列表」按钮后的刷新中状态（列表未变化时给可见反馈） */
  const [refreshing, setRefreshing] = useState(false)
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  /** chats = 普通对话；employees = 智能体员工；depts = 部门群聊 */
  const [listTab, setListTab] = useState<'chats' | 'employees' | 'depts'>(() => {
    const m = loadShellSidebarViewMode()
    if (m === 'project') return 'employees'
    if (m === 'depts') return 'depts'
    return 'chats'
  })
  /** 视图：grouped=任务；project=员工；depts=部门 */
  const [viewMode, setViewMode] = useState<'grouped' | 'project' | 'depts'>(() =>
    loadShellSidebarViewMode(),
  )
  const [deptRows, setDeptRows] = useState<DeptChatMeta[]>(() => getCachedDeptList() || [])
  const [deptLoading, setDeptLoading] = useState(false)
  const deptRowsRef = useRef(deptRows)
  deptRowsRef.current = deptRows

  // viewMode 和 listTab 联动；持久化跨刷新对齐上次关闭态
  useEffect(() => {
    setListTab(viewMode === 'project' ? 'employees' : viewMode === 'depts' ? 'depts' : 'chats')
    saveShellSidebarViewMode(viewMode)
  }, [viewMode])
  const [focusedWorkspaceKey, setFocusedWorkspaceKey] = useState<string | null>(null)
  /** 员工 Tab：下拉选中的员工 code；空 = 全部员工 */
  const [focusedEmployeeCode, setFocusedEmployeeCode] = useState<string | null>(() =>
    loadFocusedEmployeeCode(),
  )
  const [empMenuOpen, setEmpMenuOpen] = useState(false)
  const [deptMenuOpen, setDeptMenuOpen] = useState(false)
  /** 工作空间下拉内的模糊搜索词（仅过滤下拉面板，不影响会话列表搜索） */
  const [wsMenuQuery, setWsMenuQuery] = useState('')
  /** 员工下拉内的模糊搜索词 */
  const [empMenuQuery, setEmpMenuQuery] = useState('')
  /** 部门下拉内的模糊搜索词 */
  const [deptMenuQuery, setDeptMenuQuery] = useState('')
  const [dutyFoldOpen, setDutyFoldOpen] = useState(false)
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<string[]>(() =>
    loadPinnedWorkspaceKeys(),
  )
  /** 置顶区折叠：超过 PINNED_COLLAPSED_LIMIT 条时默认收起（对齐 zcode pinned section） */
  const [pinnedExpanded, setPinnedExpanded] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    sessionKey: string
    x: number
    y: number
  } | null>(null)
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceFolderContextMenuState | null>(null)
  const [employeeContextMenu, setEmployeeContextMenu] =
    useState<EmployeeGroupContextMenuState | null>(null)
  /** BOT 分组手动排序（拖拽后 localStorage；未点名时回落到花名册编制序） */
  const [employeeGroupOrder, setEmployeeGroupOrder] = useState<string[]>(() =>
    loadEmployeeGroupOrder(),
  )
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() =>
    loadExpandedWorkspaceKeys(),
  )
  /** 会话归档标记（对齐 zcode taskList.archive；localStorage 本机持久） */
  const [archivedKeys, setArchivedKeys] = useState<Set<string>>(() => loadArchivedSessionKeys())
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  /** 手动「标为未读」标记（点开会话即清除，对齐 zcode taskList.markAsUnread） */
  const [unreadKeys, setUnreadKeys] = useState<Set<string>>(() => loadUnreadMarkedKeys())
  /** 「移到顶部」顺序标记（workspaceKey → 有序 sessionKey，对齐 zcode taskGroup.moveToTop） */
  const [toppedOrder, setToppedOrder] = useState<ToppedSessionOrder>(() =>
    loadToppedSessionOrder(),
  )
  const listRef = useRef<HTMLUListElement>(null)
  const wsMenuRef = useRef<HTMLDivElement>(null)
  const empMenuRef = useRef<HTMLDivElement>(null)
  const deptMenuRef = useRef<HTMLDivElement>(null)
  const wsMenuSearchRef = useRef<HTMLInputElement>(null)
  const empMenuSearchRef = useRef<HTMLInputElement>(null)
  const deptMenuSearchRef = useRef<HTMLInputElement>(null)
  const loadMoreLockRef = useRef<Record<string, boolean>>({})
  const autoTabForSessionRef = useRef('')
  const focusedEmployeeCodeRef = useRef(focusedEmployeeCode)
  focusedEmployeeCodeRef.current = focusedEmployeeCode
  const onWorkspaceExpandRef = useRef(onWorkspaceExpand)
  onWorkspaceExpandRef.current = onWorkspaceExpand
  const unreadKeysRef = useRef(unreadKeys)
  unreadKeysRef.current = unreadKeys

  const onChatRoute = isChatHashRoute()
  const displaySelectedKey = String(selectedSessionKey || '').trim()
  const isSearching = !!String(sessionFilter || '').trim()
  const isEmployeesTab = listTab === 'employees'
  const isDeptsTab = listTab === 'depts'

  /** 侧栏挂载后闲时预热部门列表，第一次点「部门」尽量不空转 */
  useEffect(() => {
    const t = window.setTimeout(() => prefetchDeptChatList(), 1200)
    return () => window.clearTimeout(t)
  }, [])

  /**
   * 部门 Tab：只打 `/proactive/departments`（已含 members）。
   * 有缓存 / 旧列表时静默刷新，不再每次切 Tab 先亮「加载中…」再等 roles（Best-effort 易 503）。
   */
  useEffect(() => {
    if (!isDeptsTab) return
    let cancelled = false
    const warm = getCachedDeptList()
    if (warm?.length && deptRowsRef.current.length === 0) {
      setDeptRows(warm)
    }
    const showSpinner = deptRowsRef.current.length === 0 && !(warm && warm.length)
    if (showSpinner) setDeptLoading(true)
    void loadDeptChatList({ force: true })
      .then((rows) => {
        if (cancelled) return
        setDeptRows(rows)
      })
      .catch((e) => {
        console.warn('[shell] dept tab load failed', e)
      })
      .finally(() => {
        if (!cancelled) setDeptLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isDeptsTab])

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

  const onRefreshSessionListRef = useRef(onRefreshSessionList)
  onRefreshSessionListRef.current = onRefreshSessionList

  useEffect(() => {
    const onEmployeesUpdated = () => {
      // 加人/删人后：会话列表 + 花名册一起刷新（父级 useProactiveRoles 也会听同事件）
      void Promise.resolve(onRefreshSessionListRef.current?.()).catch(() => {})
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

  /**
   * 选中会话时对齐 Tab（只在 sessionKey 变化时跑一次，不覆盖之后手动点 Tab）。
   * 部门 / 员工会话分别落到对应 Tab；普通会话不强制切回「任务」。
   */
  useEffect(() => {
    if (!displaySelectedKey) return
    if (autoTabForSessionRef.current === displaySelectedKey) return
    autoTabForSessionRef.current = displaySelectedKey
    if (isDeptChatSessionKey(displaySelectedKey)) {
      setViewMode('depts')
      return
    }
    if (isProactiveSessionKey(displaySelectedKey)) {
      setViewMode('project')
    }
  }, [displaySelectedKey])

  /**
   * 冷启动 / 切到员工会话：若员工筛选与当前选中会话岗位不一致，清到「全部员工」，
   * 避免右侧已打开某员工会话、左侧因筛选隐藏该行。运行时点选会话不改写筛选（见下方注释）。
   */
  useEffect(() => {
    if (!displaySelectedKey || !isProactiveSessionKey(displaySelectedKey)) return
    const focused = focusedEmployeeCodeRef.current
    if (!focused) return
    const code = proactiveAgentCodeFromSessionKey(displaySelectedKey)
    if (!code) return
    if (focused.toLowerCase() === code.toLowerCase()) return
    setFocusedEmployeeCode(null)
    saveFocusedEmployeeCode(null)
  }, [displaySelectedKey])

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
      // 点开会话即清除「标为未读」手动标记（对齐 zcode 未读语义）
      if (unreadKeysRef.current.has(key)) {
        setUnreadKeys(markSessionUnread(key, false))
      }
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

  /** 行所属工作空间的本地路径（特殊组 / 未注册目录返回空） */
  const resolveRowWorkspacePath = useCallback(
    (row: ShellSidebarSyncRow | null | undefined): string => {
      if (!row) return ''
      const wsKey = String(row.workspaceKey || '').trim()
      if (!wsKey || isSpecialWorkspaceGroupKey(wsKey)) return ''
      const g = groups.find((x) => x.workspaceKey === wsKey)
      return (g ? resolveShellGroupWorkspacePath(g, registeredWorkspacePaths) : '') || ''
    },
    [groups, registeredWorkspacePaths],
  )

  const copyTextToClipboard = useCallback(async (text: string, okLabel: string) => {
    const value = String(text || '')
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      toast(okLabel, 'success')
    } catch {
      toast('复制失败，请手动复制', 'error')
    }
  }, [])

  /** 在文件管理器打开会话工作空间（对齐 zcode「在文件管理器中打开」） */
  const revealRowWorkspaceFolder = useCallback(
    async (row: ShellSidebarSyncRow | null | undefined) => {
      const raw = resolveRowWorkspacePath(row)
      if (!raw) {
        toast('该会话没有可打开的本地工作空间', 'info')
        return
      }
      try {
        const { api } = await import('../../lib/tauri-api.js')
        const resolvedInfo = await api.resolveWorkspacePath(raw)
        const resolved = String(resolvedInfo?.resolved || raw).trim()
        if (!resolved) {
          toast('无法解析文件夹路径', 'error')
          return
        }
        if (resolvedInfo?.exists === false) {
          toast(`目录不存在：${resolved}`, 'error')
          return
        }
        if (resolvedInfo?.is_dir === false) {
          toast(`不是文件夹：${resolved}`, 'error')
          return
        }
        await api.revealPathInFileManager(resolved)
        toast('已在文件管理器中打开', 'success')
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [resolveRowWorkspacePath],
  )

  /** 移动会话到其他工作空间（对齐 zcode taskGroup.moveToGroup；复用 workspace-bind API） */
  const handleMoveToWorkspace = useCallback(
    async (sessionKey: string, workspaceKey: string) => {
      const key = String(sessionKey || '').trim()
      const g = groups.find((x) => x.workspaceKey === workspaceKey)
      const path = (g ? resolveShellGroupWorkspacePath(g, registeredWorkspacePaths) : '') || ''
      if (!key || !path) {
        toast('目标工作空间没有本地路径', 'error')
        return
      }
      try {
        const { wsClient } = await import('../../lib/ws-client.js')
        await wsClient.bindSessionWorkspace(key, path, { userPinned: true })
        toast('已移动到目标工作空间', 'success')
        removeToppedSession(key)
        void Promise.resolve(onRefreshSessionList()).catch(() => {})
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [groups, registeredWorkspacePaths, onRefreshSessionList],
  )

  const runMenuAction = useCallback(
    (action: SessionMenuAction, sessionKey: string) => {
      const key = String(sessionKey || '').trim()
      if (!key) return
      setContextMenu(null)
      onMoreMenuClose()
      if (action === 'stop') {
        onStopSession(key)
        return
      }
      if (action === 'delete') {
        // 删除时一并清掉本行视图状态（归档 / 未读 / 置顶顺序）
        setArchivedKeys(setSessionArchived(key, false))
        setUnreadKeys(markSessionUnread(key, false))
        removeToppedSession(key)
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
      if (action === 'top') {
        const row = rows.find((r) => String(r.sessionKey || '') === key)
        setToppedOrder(topSessionInWorkspace(String(row?.workspaceKey || ''), key))
        return
      }
      if (action === 'archive') {
        setArchivedKeys(setSessionArchived(key, true))
        removeToppedSession(key)
        setUnreadKeys(markSessionUnread(key, false))
        toast('已归档', 'success')
        return
      }
      if (action === 'unarchive') {
        setArchivedKeys(setSessionArchived(key, false))
        toast('已取消归档', 'success')
        return
      }
      if (action === 'mark-unread') {
        setUnreadKeys(markSessionUnread(key, true))
        return
      }
      if (action === 'copy-id') {
        void copyTextToClipboard(key, '已复制会话 ID')
        return
      }
      if (action === 'copy-path') {
        const row = rows.find((r) => String(r.sessionKey || '') === key)
        const p = resolveRowWorkspacePath(row)
        if (!p) {
          toast('该会话没有本地工作空间路径', 'info')
          return
        }
        void copyTextToClipboard(p, '已复制路径')
        return
      }
      if (action === 'reveal') {
        const row = rows.find((r) => String(r.sessionKey || '') === key)
        void revealRowWorkspaceFolder(row)
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
    [
      copyTextToClipboard,
      onDeleteSession,
      onForkSession,
      onMoreMenuClose,
      onPinSession,
      onRefreshSession,
      onStopSession,
      resolveRowWorkspacePath,
      revealRowWorkspaceFolder,
      rows,
    ],
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

  /** 归档行从 pinned/recent/员工分组剔除，单独落到底部「已归档」区（对齐 zcode ArchiveGroupCard） */
  const nonArchivedRows = useMemo(() => {
    if (archivedKeys.size === 0) return rows
    return rows.filter((r) => !archivedKeys.has(String(r.sessionKey || '')))
  }, [rows, archivedKeys])

  const archivedRows = useMemo(() => {
    if (archivedKeys.size === 0) return [] as ShellSidebarSyncRow[]
    return rows
      .filter((r) => archivedKeys.has(String(r.sessionKey || '')))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  }, [rows, archivedKeys])

  /** 「移到顶部」排序位次：sessionKey → 标记顺序 */
  const toppedRankMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const list of Object.values(toppedOrder)) {
      list.forEach((k, idx) => {
        if (!map.has(k)) map.set(k, idx)
      })
    }
    return map
  }, [toppedOrder])

  /** recent 区排序：移到顶部的行先按标记顺序排前，其余按更新时间倒序 */
  const byToppedThenUpdated = useCallback(
    (a: ShellSidebarSyncRow, b: ShellSidebarSyncRow) => {
      const ra = toppedRankMap.get(String(a.sessionKey || ''))
      const rb = toppedRankMap.get(String(b.sessionKey || ''))
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    },
    [toppedRankMap],
  )

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

  useEffect(() => {
    if (!deptMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (t && deptMenuRef.current?.contains(t)) return
      setDeptMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDeptMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [deptMenuOpen])

  useEffect(() => {
    if (!deptMenuOpen) return
    const t = window.setTimeout(() => deptMenuSearchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [deptMenuOpen])

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
      markShellEmptyDraft(sk)
      onSelectSession(sk)
    },
    [onSelectSession],
  )

  /** 员工 Tab：会话 ∪ 雇佣花名册；默认编制序，拖拽偏好覆盖 */
  const employeeGroups = useMemo(() => {
    if (!isEmployeesTab) return [] as EmployeeSidebarGroup[]
    const sessionOnly = nonArchivedRows.filter((r) => r.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
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
    return applyEmployeeGroupOrder(
      groups.map((g) => ({ key: normalizeEmployeeCodeKey(g.agentCode), group: g })),
      employeeGroupOrder,
    ).map((x) => x.group)
  }, [
    isEmployeesTab,
    nonArchivedRows,
    effectiveEmployeeRoles,
    agents,
    sessionFilter,
    employeeGroupOrder,
  ])

  const focusedEmployeeGroup = useMemo(() => {
    if (!focusedEmployeeCode) return null
    const lc = focusedEmployeeCode.toLowerCase()
    return employeeGroups.find((g) => g.agentCode.toLowerCase() === lc) || null
  }, [focusedEmployeeCode, employeeGroups])

  const employeeFilterLabel = focusedEmployeeGroup?.label || '全部 BOT'

  const activeDeptId = useMemo(
    () => deptIdFromSessionKey(displaySelectedKey),
    [displaySelectedKey],
  )
  const activeDept = useMemo(() => {
    if (!activeDeptId) return null
    return deptRows.find((d) => d.id === activeDeptId) || getDeptChatMeta(activeDeptId)
  }, [activeDeptId, deptRows])
  const deptFilterLabel = activeDept?.name || '全部部门'

  const deptMenuOptions = useMemo(() => {
    const q = String(deptMenuQuery || '').trim().toLowerCase()
    if (!q) return deptRows
    return deptRows.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.members.some((m) => m.role_name.toLowerCase().includes(q)),
    )
  }, [deptRows, deptMenuQuery])

  const selectDeptFromMenu = useCallback(
    (dept: DeptChatMeta | null) => {
      setDeptMenuQuery('')
      setDeptMenuOpen(false)
      if (!dept) return
      rememberDeptChatMeta(dept)
      handleSelect(deptChatSessionKey(dept.id))
    },
    [handleSelect],
  )

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
    // 全部 BOT：组头已标明 Owner，行上 Trigger 芯片标明来源，标题不再拼员工名
    return employeeGroups.flatMap((g) => g.sessions)
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
    let list = nonArchivedRows
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
  }, [nonArchivedRows, focusedWorkspaceKey, isEmployeesTab, employeeSessionRows])

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
    let list = nonArchivedRows.filter((r) => !pinnedKeySet.has(String(r.sessionKey || '')))
    list = list.filter((r) => r.workspaceKey !== WORKSPACE_GROUP_PROACTIVE)
    if (focusedWorkspaceKey) {
      const nk = normalizePinKey(focusedWorkspaceKey)
      list = list.filter((r) => normalizePinKey(r.workspaceKey) === nk)
    }
    return [...list].sort(byToppedThenUpdated)
  }, [nonArchivedRows, pinnedKeySet, focusedWorkspaceKey, isEmployeesTab, employeeSessionRows, byToppedThenUpdated])

  const selectEmployeeFilter = useCallback((code: string | null) => {
    const next = code ? String(code).trim() || null : null
    setFocusedEmployeeCode(next)
    saveFocusedEmployeeCode(next)
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
          employeeOwnerCodeFromSession(row) ||
          String(row.workspaceKey || '').toLowerCase()
        if (!code || code === WORKSPACE_GROUP_PROACTIVE) continue
        const lc = normalizeEmployeeCodeKey(code)
        const entry = byCode.get(lc) || { label: '', rows: [], avatarAgentCode: code }
        if (!entry.label) {
          entry.label = resolveEmployeeGroupLabel(code, effectiveEmployeeRoles, agents)
        }
        entry.rows.push(row)
        byCode.set(lc, entry)
      }
      if (byCode.size <= 1) return null
      const sections = Array.from(byCode.entries()).map(([key, value]) => ({
        key,
        label: value.label || key,
        rows: value.rows,
        avatarAgentCode: value.avatarAgentCode || key,
      }))
      // 组头：编制序为底；有本机拖拽偏好则覆盖（会话仍按组内 updatedAt）
      const rosterOrder = employeeRosterOrderKeys(effectiveEmployeeRoles)
      const baseOrdered = applyEmployeeGroupOrder(sections, rosterOrder)
      return applyEmployeeGroupOrder(baseOrdered, employeeGroupOrder)
    }
    if (focusedWorkspaceKey) return null
    // 已注册但暂无会话的工作区也要成组展示，避免新建工作空间后左侧看不到
    return buildWorkspaceRecentSections(recentVisibleRows, groups, { searching: isSearching })
  }, [
    recentVisibleRows,
    isEmployeesTab,
    focusedEmployeeCode,
    focusedWorkspaceKey,
    groups,
    effectiveEmployeeRoles,
    agents,
    isSearching,
    employeeGroupOrder,
  ])

  /** 只有「空工作区分组」需要展示（尚无任何会话）——此时不能走「暂无会话」空态 */
  const showEmptyWorkspaceSections = !!groupedRecentSections && recentVisibleRows.length === 0

  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /** 「移动到工作空间」子菜单目标：其余有本地路径的普通工作空间（对齐 zcode taskGroup.moveToGroup）。
   *  BOT/虚拟组会话与无其他目标时返回 undefined（隐藏该菜单项）。 */
  const buildRowMoveTargets = useCallback(
    (row: ShellSidebarSyncRow | null | undefined): SessionMoveTarget[] | undefined => {
      const currentWs = String(row?.workspaceKey || '').trim()
      if (
        currentWs === WORKSPACE_GROUP_PROACTIVE ||
        currentWs === WORKSPACE_GROUP_VIRTUAL ||
        isProactiveSessionKey(String(row?.sessionKey || ''))
      ) {
        return undefined
      }
      const targets: SessionMoveTarget[] = []
      for (const g of workspaceFilterOptions) {
        const key = String(g.workspaceKey || '').trim()
        if (!key || key === currentWs) continue
        if (!resolveShellGroupWorkspacePath(g, registeredWorkspacePaths)) continue
        targets.push({ workspaceKey: key, label: String(g.label || key) })
      }
      return targets.length > 0 ? targets : undefined
    },
    [workspaceFilterOptions, registeredWorkspacePaths],
  )

  const renderSessionRow = (row: ShellSidebarSyncRow) => {
    const sk = String(row.sessionKey || '')
    const active = onChatRoute && sk === displaySelectedKey
    return (
      <ShellSessionListRow
        key={sk}
        row={row}
        active={active}
        archived={archivedKeys.has(sk)}
        unreadMarked={unreadKeys.has(sk)}
        hasWorkspacePath={!!resolveRowWorkspacePath(row)}
        moveTargets={buildRowMoveTargets(row)}
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
        onMoveToWorkspace={(targetKey) => void handleMoveToWorkspace(sk, targetKey)}
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

  /** 工作区 / BOT 分组头拖拽换序。
   *  与置顶行拖拽同款 pointer 拖拽：按下移动 >5px 视为拖拽，落到目标组头换序；
   *  任务 Tab 走 bridge 持久化，BOT Tab 走本机 employeeGroupOrder。 */
  const wsGroupDragRef = useRef<{ key: string; dragging: boolean; startY: number } | null>(null)

  const handleWorkspaceGroupHeadPointerDown = useCallback(
    (sectionKey: string, e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('button, input, a')) return

      if (isEmployeesTab) {
        const fromKey = normalizeEmployeeCodeKey(sectionKey)
        if (!fromKey) return
        const host = e.currentTarget
        wsGroupDragRef.current = { key: fromKey, dragging: false, startY: e.clientY }
        host.classList.add('react-chat-session-ws-head--dragging')
        document.body.classList.add('react-chat-session-row-dragging')

        const clearDragOver = () => {
          document.querySelectorAll('.react-chat-session-ws-head--drag-over').forEach((n) => {
            n.classList.remove('react-chat-session-ws-head--drag-over')
          })
        }

        const onMove = (ev: PointerEvent) => {
          const drag = wsGroupDragRef.current
          if (!drag) return
          if (Math.abs(ev.clientY - drag.startY) > 5) drag.dragging = true
          clearDragOver()
          if (!drag.dragging) return
          const under = document.elementFromPoint(ev.clientX, ev.clientY)
          const drop = under?.closest?.('[data-ws-group-head]') as HTMLElement | null
          const dropKey = normalizeEmployeeCodeKey(String(drop?.dataset?.wsGroupHead || ''))
          if (drop && drop !== host && dropKey && dropKey !== fromKey) {
            drop.classList.add('react-chat-session-ws-head--drag-over')
          }
        }

        const onUp = (ev: PointerEvent) => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          document.body.classList.remove('react-chat-session-row-dragging')
          host.classList.remove('react-chat-session-ws-head--dragging')
          clearDragOver()
          const drag = wsGroupDragRef.current
          wsGroupDragRef.current = null
          if (!drag?.dragging) return
          const under = document.elementFromPoint(ev.clientX, ev.clientY)
          const drop = under?.closest?.('[data-ws-group-head]') as HTMLElement | null
          const dropKey = normalizeEmployeeCodeKey(String(drop?.dataset?.wsGroupHead || ''))
          if (!dropKey || dropKey === fromKey) return
          setEmployeeGroupOrder((prev) => {
            const present = (groupedRecentSections || []).map((s) =>
              normalizeEmployeeCodeKey(s.key),
            )
            const next = reorderEmployeeGroupKeys(prev, fromKey, dropKey, present)
            saveEmployeeGroupOrder(next)
            return next
          })
        }

        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
        return
      }

      if (isSpecialWorkspaceGroupKey(sectionKey)) return
      if (typeof onReorderWorkspaceGroups !== 'function') return
      const host = e.currentTarget
      wsGroupDragRef.current = { key: sectionKey, dragging: false, startY: e.clientY }
      host.classList.add('react-chat-session-ws-head--dragging')
      document.body.classList.add('react-chat-session-row-dragging')

      const clearDragOver = () => {
        document.querySelectorAll('.react-chat-session-ws-head--drag-over').forEach((n) => {
          n.classList.remove('react-chat-session-ws-head--drag-over')
        })
      }

      const onMove = (ev: PointerEvent) => {
        const drag = wsGroupDragRef.current
        if (!drag) return
        if (Math.abs(ev.clientY - drag.startY) > 5) drag.dragging = true
        clearDragOver()
        if (!drag.dragging) return
        const under = document.elementFromPoint(ev.clientX, ev.clientY)
        const drop = under?.closest?.('[data-ws-group-head]') as HTMLElement | null
        const dropKey = String(drop?.dataset?.wsGroupHead || '').trim()
        if (drop && drop !== host && dropKey && !isSpecialWorkspaceGroupKey(dropKey)) {
          drop.classList.add('react-chat-session-ws-head--drag-over')
        }
      }

      const onUp = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.body.classList.remove('react-chat-session-row-dragging')
        host.classList.remove('react-chat-session-ws-head--dragging')
        clearDragOver()
        const drag = wsGroupDragRef.current
        wsGroupDragRef.current = null
        if (!drag?.dragging) return
        const under = document.elementFromPoint(ev.clientX, ev.clientY)
        const drop = under?.closest?.('[data-ws-group-head]') as HTMLElement | null
        const dropKey = String(drop?.dataset?.wsGroupHead || '').trim()
        if (dropKey && dropKey !== sectionKey && !isSpecialWorkspaceGroupKey(dropKey)) {
          onReorderWorkspaceGroups(sectionKey, dropKey)
        }
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [isEmployeesTab, onReorderWorkspaceGroups, groupedRecentSections],
  )

  const handleNewSessionClick = useCallback(() => {
    // 曾误写 setFilterOpen(false)（状态不存在）→ 点击抛 ReferenceError，空态 CTA「完全没反应」
    onSessionFilterChange('')
    document.getElementById('app-shell-aside')?.classList.remove('shell-aside-open')
    document.getElementById('shell-aside-overlay')?.classList.remove('visible')
    if (isEmployeesTab) {
      const code = String(focusedEmployeeCode || '').trim()
      if (!code) {
        setEmpMenuOpen(true)
        return
      }
      if (!isChatHashRoute()) navigate('/chat')
      openNewEmployeeChat(code)
      return
    }
    // 一律走新建会话（即时切空白草稿），不要点侧栏「新建对话」——那会走 open-home，
    // 已在空工作台时只滚动不反馈，感觉像「点了没反应」。
    const path = focusedGroup
      ? focusedGroup.workspaceKey === WORKSPACE_GROUP_UNBOUND
        ? null
        : resolveShellGroupWorkspacePath(focusedGroup, registeredWorkspacePaths)
      : null
    if (!isChatHashRoute()) navigate('/chat')
    onNewSessionInWorkspace?.(path)
  }, [
    focusedGroup,
    focusedEmployeeCode,
    isEmployeesTab,
    onNewSessionInWorkspace,
    onSessionFilterChange,
    openNewEmployeeChat,
    registeredWorkspacePaths,
  ])

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
              <span>BOT</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'depts'}
              className={`shell-view-tab${viewMode === 'depts' ? ' is-active' : ''}`}
              onPointerEnter={() => {
                // 悬停写入模块缓存，点进 Tab 可直接画列表
                prefetchDeptChatList()
              }}
              onClick={() => setViewMode('depts')}
            >
              <ShellEmployeesIcon size={12} />
              <span>部门</span>
            </button>
          </div>

          {/* 操作按钮：顶栏筛选/+ 暂隐，只留刷新，避免 tabs 挤成一团 */}
          <div className="shell-view-actions">
            <button
              type="button"
              className={`shell-view-action-btn${refreshing ? ' is-refreshing' : ''}`}
              title={refreshing ? '正在刷新…' : '刷新会话列表'}
              aria-label={refreshing ? '正在刷新…' : '刷新会话列表'}
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                void Promise.resolve(onRefreshSessionList())
                  .catch(() => {})
                  .finally(() => {
                    setRefreshing(false)
                  })
              }}
            >
              <ShellRefreshIcon size={13} />
            </button>
          </div>
        </div>

        {isDeptsTab ? (
          <div className="react-chat-aside-ws-picker" ref={deptMenuRef}>
            <button
              type="button"
              className={`react-chat-aside-ws-trigger${deptMenuOpen ? ' is-open' : ''}${
                activeDeptId ? ' has-filter' : ''
              }`}
              aria-haspopup="listbox"
              aria-expanded={deptMenuOpen}
              title={activeDept?.name || deptFilterLabel}
              onClick={() => setDeptMenuOpen((v) => !v)}
            >
              {activeDept ? (
                <AssignedAgentAvatar
                  agentCode={
                    String(activeDept.head_agent_code || '').trim() ||
                    String(activeDept.members[0]?.agent_code || '').trim() ||
                    undefined
                  }
                  agents={agents}
                  size={16}
                  className="react-chat-aside-ws-trigger-ic"
                />
              ) : (
                <ShellDeptsIcon size={14} className="react-chat-aside-ws-trigger-ic" />
              )}
              <span className="react-chat-aside-ws-trigger-label">{deptFilterLabel}</span>
              <ShellChevronIcon
                size={12}
                className={`react-chat-aside-ws-trigger-chevron${deptMenuOpen ? ' is-open' : ''}`}
              />
            </button>
            {deptMenuOpen ? (
              <div className="react-chat-aside-ws-menu" role="listbox" aria-label="选择部门">
                <div className="react-chat-aside-ws-menu-search">
                  <input
                    ref={deptMenuSearchRef}
                    type="search"
                    className="react-chat-aside-ws-menu-search-input"
                    placeholder="搜索部门…"
                    aria-label="搜索部门"
                    value={deptMenuQuery}
                    onChange={(e) => setDeptMenuQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setDeptMenuQuery('')
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={!activeDeptId}
                  className={`react-chat-aside-ws-menu-item${!activeDeptId ? ' is-active' : ''}`}
                  onClick={() => {
                    setDeptMenuQuery('')
                    setDeptMenuOpen(false)
                  }}
                >
                  <span className="react-chat-aside-ws-menu-item-label">全部部门</span>
                </button>
                {deptMenuOptions.map((d) => {
                  const active = activeDeptId === d.id
                  const avatarCode =
                    String(d.head_agent_code || '').trim() ||
                    String(d.members[0]?.agent_code || '').trim()
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`react-chat-aside-ws-menu-item${active ? ' is-active' : ''}`}
                      title={`${d.members.length} 人`}
                      onClick={() => selectDeptFromMenu(d)}
                    >
                      {avatarCode ? (
                        <AssignedAgentAvatar
                          agentCode={avatarCode}
                          agents={agents}
                          size={16}
                          className="react-chat-aside-ws-menu-item-avatar"
                        />
                      ) : (
                        <ShellDeptsIcon size={14} className="react-chat-aside-ws-menu-item-avatar" />
                      )}
                      <span className="react-chat-aside-ws-menu-item-label">{d.name}</span>
                      <span className="react-chat-aside-ws-menu-item-count">{d.members.length}</span>
                    </button>
                  )
                })}
                {String(deptMenuQuery || '').trim() && deptMenuOptions.length === 0 ? (
                  <div className="react-chat-aside-ws-menu-empty">无匹配部门</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : !isEmployeesTab ? (
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
              <div className="react-chat-aside-ws-menu" role="listbox" aria-label="选择 BOT">
                <div className="react-chat-aside-ws-menu-search">
                  <input
                    ref={empMenuSearchRef}
                    type="search"
                    className="react-chat-aside-ws-menu-search-input"
                    placeholder="搜索 BOT…"
                    aria-label="搜索 BOT"
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
                  <span className="react-chat-aside-ws-menu-item-label">全部 BOT</span>
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
                  <div className="react-chat-aside-ws-menu-empty">无匹配 BOT</div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <ul ref={listRef} className="react-chat-session-list" id="shell-session-list">
          {isDeptsTab ? (
            <>
              {deptLoading ? (
                <li className="react-chat-muted" style={{ padding: '10px 12px' }}>
                  加载中…
                </li>
              ) : null}
              {!deptLoading &&
                (() => {
                  const q = String(sessionFilter || '').trim().toLowerCase()
                  const filtered = q
                    ? deptRows.filter(
                        (d) =>
                          d.name.toLowerCase().includes(q) ||
                          d.members.some((m) => m.role_name.toLowerCase().includes(q)),
                      )
                    : deptRows
                  if (!filtered.length) {
                    return (
                      <li
                        className="react-chat-muted react-chat-session-empty-state"
                        style={{ padding: '10px 12px' }}
                      >
                        <span>{q ? '无匹配部门' : '暂无有成员的部门'}</span>
                      </li>
                    )
                  }
                  return filtered.map((d) => {
                    const sk = deptChatSessionKey(d.id)
                    const active = displaySelectedKey === sk
                    const head =
                      d.head_role_name ||
                      d.members.find((m) => m.agent_code === d.head_agent_code)?.role_name ||
                      ''
                    const avatarCode =
                      String(d.head_agent_code || '').trim() ||
                      String(d.members[0]?.agent_code || '').trim()
                    return (
                      <li key={d.id} className="react-chat-session-item-wrap">
                        <button
                          type="button"
                          className={`react-chat-session-item shell-dept-row${active ? ' active' : ''}`}
                          onClick={() => {
                            try {
                              rememberDeptChatMeta(d)
                            } catch {
                              /* ignore */
                            }
                            handleSelect(sk)
                          }}
                        >
                          {avatarCode ? (
                            <AssignedAgentAvatar
                              agentCode={avatarCode}
                              agents={agents}
                              size={20}
                              className="shell-dept-row__avatar"
                            />
                          ) : (
                            <span className="shell-dept-row__avatar shell-dept-row__avatar--empty" aria-hidden>
                              {String(d.name || '部').trim().slice(0, 1) || '部'}
                            </span>
                          )}
                          <span className="shell-dept-row__body">
                            <span className="shell-dept-row__title">{d.name}</span>
                            <span className="shell-dept-row__meta">
                              {d.members.length}人
                              {head ? ` · ${head}` : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })
                })()}
            </>
          ) : null}

          {!isDeptsTab && listLoading ? (
            <li className="react-chat-muted" style={{ padding: '10px 12px' }}>
              加载中…
            </li>
          ) : null}

          {!isDeptsTab &&
          !listLoading &&
          pinnedRows.length === 0 &&
          recentVisibleRows.length === 0 &&
          !showDutyFold &&
          !showEmptyWorkspaceSections &&
          archivedRows.length === 0 ? (
            <li className="react-chat-muted react-chat-session-empty-state" style={{ padding: '10px 12px' }}>
              <span>
                {isEmployeesTab
                  ? isSearching
                    ? '无匹配会话'
                    : focusedEmployeeCode
                      ? '该 BOT 暂无会话'
                      : (effectiveEmployeeRoles || []).length > 0
                        ? '暂无 BOT 对话'
                        : '暂无已雇佣 BOT'
                  : focusedWorkspaceKey
                    ? '此工作空间暂无会话'
                    : isSearching
                      ? '无匹配会话'
                      : '暂无会话'}
              </span>
              {/* 空态 CTA：搜索中不引导新建（避免误导为"新建能找到"） */}
              {!isSearching ? (
                <button
                  type="button"
                  className="react-chat-session-empty-cta"
                  onClick={handleNewSessionClick}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>新建对话</span>
                </button>
              ) : null}
            </li>
          ) : null}

          {!isDeptsTab && !listLoading && pinnedRows.length > 0 ? (
            <li className="react-chat-session-pinned-block" aria-label="固定会话">
              <ul className="react-chat-session-pinned-list">
                {(pinnedExpanded
                  ? pinnedRows
                  : pinnedRows.slice(0, PINNED_COLLAPSED_LIMIT)
                ).map((row) => renderSessionRow(row))}
              </ul>
              {pinnedRows.length > PINNED_COLLAPSED_LIMIT ? (
                <button
                  type="button"
                  className="react-chat-session-pinned-toggle"
                  onClick={() => setPinnedExpanded((prev) => !prev)}
                >
                  {pinnedExpanded
                    ? '收起置顶会话'
                    : `展开全部置顶会话（共 ${pinnedRows.length} 条）`}
                </button>
              ) : null}
            </li>
          ) : null}

          {!isDeptsTab &&
          !listLoading &&
          (recentVisibleRows.length > 0 ||
            showDutyFold ||
            flatHasMore ||
            flatLoading ||
            showEmptyWorkspaceSections) ? (
            <li
              className="react-chat-session-recent-block"
              aria-label={isEmployeesTab ? 'BOT' : '任务'}
            >
              <ul className="react-chat-session-recent-list">
                {groupedRecentSections
                  ? groupedRecentSections.map((section) => {
                      const collapsed = collapsedGroupKeys.has(section.key)
                      return (
                        <li key={`ws-${section.key}`} className="react-chat-session-ws-group">
                          <div
                            className="group/ws flex h-6 min-w-0 cursor-pointer items-center gap-2 rounded-lg pl-2 pr-1 transition-colors hover:bg-surface-hover"
                            data-ws-group-head={section.key}
                            onClick={() => toggleGroupCollapsed(section.key)}
                            onPointerDown={(e) => handleWorkspaceGroupHeadPointerDown(section.key, e)}
                          >
                            <span className="relative flex size-3.5 shrink-0 items-center justify-center">
                              {isEmployeesTab && section.avatarAgentCode ? (
                                <AssignedAgentAvatar
                                  agentCode={section.avatarAgentCode}
                                  agents={agents}
                                  size={14}
                                />
                              ) : collapsed ? (
                                <FolderIcon className='size-3.5 text-foreground-subtle' />
                              ) : (
                                <FolderOpenIcon className='size-3.5 text-foreground-subtle' />
                              )}
                            </span>
                            <span className='react-chat-session-ws-group-label min-w-0 flex-1 truncate'>
                              {section.label}
                            </span>
                            <span className='hidden shrink-0 items-center gap-1 group-hover/ws:flex'>
                              <button
                                type='button'
                                className='flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-transparent bg-transparent text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground'
                                title={isEmployeesTab ? '新开 BOT 对话' : '新建任务'}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  // 员工 Tab 组头 key = agent_code，必须开 proactive:…:chat:…
                                  // 不能走 onNewSessionInWorkspace（那是普通工作空间主对话，会把侧栏切回「对话」Tab）。
                                  if (isEmployeesTab) {
                                    const code = String(
                                      section.avatarAgentCode || section.key || '',
                                    ).trim()
                                    if (code) openNewEmployeeChat(code)
                                    return
                                  }
                                  const grp = groups.find((g) => g.workspaceKey === section.key)
                                  const wsPath =
                                    grp && grp.workspaceKey !== WORKSPACE_GROUP_UNBOUND
                                      ? resolveShellGroupWorkspacePath(
                                          grp,
                                          registeredWorkspacePaths,
                                        )
                                      : null
                                  if (!isChatHashRoute()) navigate('/chat')
                                  onNewSessionInWorkspace?.(wsPath)
                                }}
                              >
                                <Plus className='h-3.5 w-3.5' />
                              </button>
                              <button
                                type='button'
                                className='flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-transparent bg-transparent text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground'
                                title='更多'
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const r = e.currentTarget.getBoundingClientRect()
                                  if (isEmployeesTab) {
                                    const code = String(
                                      section.avatarAgentCode || section.key || '',
                                    ).trim()
                                    if (!code) return
                                    setEmployeeContextMenu({
                                      agentCode: code,
                                      label: section.label,
                                      x: r.left + r.width / 2,
                                      y: r.bottom,
                                    })
                                    return
                                  }
                                  const grp = groups.find((g) => g.workspaceKey === section.key)
                                  if (!grp) return
                                  // 对齐 zcode 工作区「…」菜单：打开文件夹 / 收藏 / 只看 / 删除
                                  setWorkspaceContextMenu({
                                    workspaceKey: section.key,
                                    x: r.left + r.width / 2,
                                    y: r.bottom,
                                  })
                                }}
                              >
                                <Ellipsis className='h-3.5 w-3.5' />
                              </button>
                            </span>
                          </div>
                          {!collapsed ? (
                              <ul className='react-chat-session-ws-group-list'>
                                {section.rows.length > 0 ? (
                                  section.rows.map((row) => renderSessionRow(row))
                                ) : (
                                  <li className='react-chat-muted react-chat-session-ws-group-empty'>
                                    暂无会话
                                  </li>
                                )}
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

          {/* 已归档区（对齐 zcode ArchiveGroupCard）：折叠计数，展开列出归档会话，行菜单可取消归档/删除 */}
          {!isDeptsTab && !listLoading && archivedRows.length > 0 ? (
            <li className="react-chat-session-archived-block" aria-label="已归档">
              <button
                type="button"
                className={`react-chat-session-archived-toggle${archivedExpanded ? ' is-open' : ''}`}
                aria-expanded={archivedExpanded}
                onClick={() => setArchivedExpanded((v) => !v)}
              >
                <ShellChevronIcon
                  size={12}
                  className={`react-chat-session-archived-chevron${archivedExpanded ? ' is-open' : ''}`}
                />
                <span>已归档 · {archivedRows.length}</span>
              </button>
              {archivedExpanded ? (
                <ul className="react-chat-session-archived-list">
                  {archivedRows.map((row) => renderSessionRow(row))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      </div>

      <SessionContextMenuPortal
        menu={contextMenu}
        row={contextRow}
        archived={contextRow ? archivedKeys.has(String(contextRow.sessionKey || '')) : false}
        hasWorkspacePath={!!resolveRowWorkspacePath(contextRow)}
        moveTargets={buildRowMoveTargets(contextRow)}
        onClose={() => setContextMenu(null)}
        onAction={(action) => {
          if (contextMenu) runMenuAction(action, contextMenu.sessionKey)
        }}
        onMoveToWorkspace={(targetKey) => {
          if (contextMenu) void handleMoveToWorkspace(contextMenu.sessionKey, targetKey)
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
      <EmployeeGroupContextMenuPortal
        menu={employeeContextMenu}
        focused={
          !!employeeContextMenu &&
          !!focusedEmployeeCode &&
          focusedEmployeeCode.toLowerCase() === employeeContextMenu.agentCode.toLowerCase()
        }
        onClose={() => setEmployeeContextMenu(null)}
        onFocusOnly={() => {
          const code = employeeContextMenu?.agentCode
          setEmployeeContextMenu(null)
          if (code) selectEmployeeFilter(code)
        }}
        onClearFocus={() => {
          setEmployeeContextMenu(null)
          selectEmployeeFilter(null)
        }}
        onNewChat={() => {
          const code = employeeContextMenu?.agentCode
          setEmployeeContextMenu(null)
          if (code) {
            if (!isChatHashRoute()) navigate('/chat')
            openNewEmployeeChat(code)
          }
        }}
        onOpenEmployeePage={() => {
          const code = employeeContextMenu?.agentCode
          setEmployeeContextMenu(null)
          if (code) navigate(`/proactive/${encodeURIComponent(code)}`)
        }}
      />
    </>
  )
}
