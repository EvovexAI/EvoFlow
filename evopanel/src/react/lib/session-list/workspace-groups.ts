import type { ChatSessionRow } from '../../chat-types.js'
import { compareSessionRows } from './utils.js'
import type { ShellSidebarSyncRow, ShellWorkspaceGroup, WorkspaceGroupSummary } from './types.js'

export const WORKSPACE_GROUP_VIRTUAL = '__virtual__'
export const WORKSPACE_GROUP_UNBOUND = '__unbound__'
export const WORKSPACE_GROUP_PROACTIVE = '__proactive__'
export const WORKSPACE_GROUP_DEFAULT_LABEL = '默认'
export const WORKSPACE_GROUP_PROACTIVE_LABEL = '智能体员工'

const SPECIAL_WORKSPACE_GROUP_KEYS = new Set([
  WORKSPACE_GROUP_VIRTUAL,
  WORKSPACE_GROUP_UNBOUND,
  WORKSPACE_GROUP_PROACTIVE,
])

export type ResolvedWorkspaceGroup = {
  workspaceKey: string
  label: string
  path: string
}

export function isProactiveSessionKey(sessionKey: string | null | undefined): boolean {
  return String(sessionKey || '').trim().startsWith('proactive:')
}

const PROACTIVE_KIND_MARKERS = [':duty:', ':task:', ':chat:'] as const

/** Parse ``proactive:{code}`` / ``proactive:{code}:duty|task|chat:…`` */
export function parseProactiveSessionKey(sessionKey: string | null | undefined): {
  agentCode: string
  kind: 'legacy' | 'duty' | 'task' | 'chat'
  suffix: string
  taskId: string
  legacy: boolean
} {
  const sk = String(sessionKey || '').trim()
  const empty = { agentCode: '', kind: 'legacy' as const, suffix: '', taskId: '', legacy: true }
  if (!sk.startsWith('proactive:')) return empty
  const rest = sk.slice('proactive:'.length)
  for (const marker of PROACTIVE_KIND_MARKERS) {
    const idx = rest.indexOf(marker)
    if (idx >= 0) {
      const kind = marker.slice(1, -1) as 'duty' | 'task' | 'chat'
      const suffix = rest.slice(idx + marker.length)
      return {
        agentCode: rest.slice(0, idx).trim(),
        kind,
        suffix,
        taskId: kind === 'task' ? suffix : '',
        legacy: false,
      }
    }
  }
  return {
    agentCode: rest.trim(),
    kind: 'legacy',
    suffix: '',
    taskId: '',
    legacy: true,
  }
}

/** ``proactive:{agent_code}`` / multi-session → agent_code；非员工会话返回空串 */
export function proactiveAgentCodeFromSessionKey(sessionKey: string | null | undefined): string {
  return parseProactiveSessionKey(sessionKey).agentCode
}

/** 智能体员工值班会话：key 前缀或 context.source */
export function isProactiveSession(
  session: Pick<ChatSessionRow, 'sessionKey' | 'context'> | null | undefined,
): boolean {
  if (!session) return false
  if (isProactiveSessionKey(session.sessionKey)) return true
  const src = String(
    (session.context as { source?: string } | undefined)?.source || '',
  )
    .trim()
    .toLowerCase()
  return src === 'proactive' || src.startsWith('proactive_')
}

export function isSpecialWorkspaceGroupKey(workspaceKey: string | null | undefined): boolean {
  return SPECIAL_WORKSPACE_GROUP_KEYS.has(String(workspaceKey || '').trim())
}

/** 侧栏分组用：解析会话所属工作目录（员工会话独立成组） */
export function resolveSessionWorkspaceGroup(
  session: ChatSessionRow,
  configuredWorkspaceRoot = '',
): ResolvedWorkspaceGroup {
  if (isProactiveSession(session)) {
    return {
      workspaceKey: WORKSPACE_GROUP_PROACTIVE,
      label: WORKSPACE_GROUP_PROACTIVE_LABEL,
      path: '',
    }
  }

  const useVirtual =
    session.useVirtualPaths === true || session.context?.use_virtual_paths === true

  if (useVirtual) {
    return {
      workspaceKey: WORKSPACE_GROUP_VIRTUAL,
      label: '虚拟工作空间',
      path: '',
    }
  }

  const root =
    String(session.localWorkspaceRoot || '').trim() ||
    String(session.context?.local_workspace_root || '').trim() ||
    String(configuredWorkspaceRoot || '').trim()

  if (!root) {
    return {
      workspaceKey: WORKSPACE_GROUP_UNBOUND,
      label: WORKSPACE_GROUP_DEFAULT_LABEL,
      path: '',
    }
  }

  const path = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    workspaceKey: path.toLowerCase(),
    label: formatWorkspaceGroupLabel(path),
    path,
  }
}

/** 展示名：目录 basename，与常见 IDE 侧栏一致 */
export function formatWorkspaceGroupLabel(path: string): string {
  const normalized = String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!normalized) return WORKSPACE_GROUP_DEFAULT_LABEL
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || normalized
}

export function groupShellSidebarRowsByWorkspace(
  rows: ShellSidebarSyncRow[],
  sessionsByKey: Map<string, ChatSessionRow>,
  configuredWorkspaceRoot = '',
): ShellWorkspaceGroup[] {
  const buckets = new Map<
    string,
    { label: string; path: string; sessions: ShellSidebarSyncRow[]; maxActivity: number }
  >()

  for (const row of rows) {
    const session = sessionsByKey.get(row.sessionKey)
    const { workspaceKey, label, path } = session
      ? resolveSessionWorkspaceGroup(session, configuredWorkspaceRoot)
      : {
          workspaceKey: WORKSPACE_GROUP_UNBOUND,
          label: WORKSPACE_GROUP_DEFAULT_LABEL,
          path: '',
        }

    let bucket = buckets.get(workspaceKey)
    if (!bucket) {
      bucket = { label, path, sessions: [], maxActivity: 0 }
      buckets.set(workspaceKey, bucket)
    }
    bucket.sessions.push(row)
    bucket.maxActivity = Math.max(bucket.maxActivity, row.updatedAt)
  }

  return [...buckets.entries()]
    .map(([workspaceKey, bucket]) => {
      const sessions = [...bucket.sessions].sort((a, b) => {
        const sa = sessionsByKey.get(a.sessionKey) || {
          sessionKey: a.sessionKey,
          createdAt: a.createdAt,
          isPinned: a.isPinned,
          pinOrder: a.pinOrder,
        }
        const sb = sessionsByKey.get(b.sessionKey) || {
          sessionKey: b.sessionKey,
          createdAt: b.createdAt,
          isPinned: b.isPinned,
          pinOrder: b.pinOrder,
        }
        return compareSessionRows(sa, sb)
      })
      return {
        workspaceKey,
        label: bucket.label,
        path: bucket.path,
        sessionCount: sessions.length,
        sessions,
        maxActivity: bucket.maxActivity,
      }
    })
    .sort((a, b) => {
      if (b.maxActivity !== a.maxActivity) return b.maxActivity - a.maxActivity
      return a.label.localeCompare(b.label, 'zh-CN')
    })
    .map(({ workspaceKey, label, path, sessionCount, sessions }) => ({
      workspaceKey,
      label,
      path,
      sessionCount,
      sessions,
    }))
}

export function normalizeWorkspacePathKey(path: string): string {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** 侧栏分组 → 绑定目录绝对路径（+ 新建 / 全局新对话共用） */
export function resolveShellGroupWorkspacePath(
  group: Pick<ShellWorkspaceGroup, 'workspaceKey' | 'path'>,
  registeredPaths: string[] = [],
): string | null {
  if (isSpecialWorkspaceGroupKey(group.workspaceKey)) {
    return null
  }
  const explicit = String(group.path || '').trim()
  if (explicit) return explicit
  const nk = normalizeWorkspacePathKey(group.workspaceKey)
  for (const raw of registeredPaths) {
    const p = String(raw || '').trim()
    if (p && normalizeWorkspacePathKey(p) === nk) return p
  }
  if (nk && (nk.includes('/') || /^[a-z]:/.test(nk))) {
    return String(group.workspaceKey || '').trim() || null
  }
  return null
}

/** 合并已注册但尚无会话的工作空间目录（侧栏空文件夹） */
export function mergeRegisteredWorkspaceGroups(
  groups: ShellWorkspaceGroup[],
  registeredPaths: string[],
): ShellWorkspaceGroup[] {
  const map = new Map(groups.map((g) => [g.workspaceKey, { ...g, sessions: [...g.sessions] }]))

  for (const raw of registeredPaths) {
    const path = String(raw || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    if (!path) continue
    const workspaceKey = normalizeWorkspacePathKey(path)
    if (map.has(workspaceKey)) continue
    map.set(workspaceKey, {
      workspaceKey,
      label: formatWorkspaceGroupLabel(path),
      path,
      sessionCount: 0,
      sessions: [],
    })
  }

  if (!map.has(WORKSPACE_GROUP_UNBOUND)) {
    map.set(WORKSPACE_GROUP_UNBOUND, {
      workspaceKey: WORKSPACE_GROUP_UNBOUND,
      label: WORKSPACE_GROUP_DEFAULT_LABEL,
      path: '',
      sessionCount: 0,
      sessions: [],
    })
  }

  const merged = [...map.values()]
  const unbound = merged.find((g) => g.workspaceKey === WORKSPACE_GROUP_UNBOUND)
  const proactive = merged.find((g) => g.workspaceKey === WORKSPACE_GROUP_PROACTIVE)
  const rest = merged
    .filter((g) => !isSpecialWorkspaceGroupKey(g.workspaceKey))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  const virtual = merged.find((g) => g.workspaceKey === WORKSPACE_GROUP_VIRTUAL)
  const out: ShellWorkspaceGroup[] = []
  if (proactive) out.push(proactive)
  out.push(...rest)
  if (virtual) out.push(virtual)
  if (unbound) out.push(unbound)
  return out
}

function summaryToShellGroup(
  summary: WorkspaceGroupSummary,
  sessions: ShellSidebarSyncRow[],
): ShellWorkspaceGroup {
  const workspaceKey = String(summary.workspaceKey || '').trim()
  if (workspaceKey === WORKSPACE_GROUP_VIRTUAL) {
    return {
      workspaceKey,
      label: '虚拟工作空间',
      path: '',
      sessionCount: Number(summary.sessionCount) || 0,
      sessions,
    }
  }
  if (workspaceKey === WORKSPACE_GROUP_PROACTIVE) {
    return {
      workspaceKey,
      label: WORKSPACE_GROUP_PROACTIVE_LABEL,
      path: '',
      sessionCount: Number(summary.sessionCount) || 0,
      sessions,
    }
  }
  if (workspaceKey === WORKSPACE_GROUP_UNBOUND) {
    return {
      workspaceKey,
      label: WORKSPACE_GROUP_DEFAULT_LABEL,
      path: '',
      sessionCount: Number(summary.sessionCount) || 0,
      sessions,
    }
  }
  const path = String(summary.localWorkspaceRoot || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  return {
    workspaceKey,
    label: formatWorkspaceGroupLabel(path),
    path,
    sessionCount: Number(summary.sessionCount) || 0,
    sessions,
  }
}

/** 用 API 汇总作为目录列表与计数来源，已加载会话挂到对应目录下 */
export function buildShellGroupsFromSummaries(
  summaries: WorkspaceGroupSummary[],
  loadedGroups: ShellWorkspaceGroup[],
  registeredPaths: string[],
): ShellWorkspaceGroup[] {
  const sessionsByKey = new Map<string, ShellSidebarSyncRow[]>()
  for (const g of loadedGroups) {
    const nk = normalizeWorkspacePathKey(g.workspaceKey) || g.workspaceKey
    const prev = sessionsByKey.get(nk) || []
    sessionsByKey.set(nk, [...prev, ...g.sessions])
  }

  const summaryByKey = new Map<string, WorkspaceGroupSummary>()
  const orderedKeys: string[] = []

  const insertBeforeSpecialKeys = (): number => {
    // 绑定目录插在「员工」之后、virtual/unbound 之前
    for (const sk of [WORKSPACE_GROUP_VIRTUAL, WORKSPACE_GROUP_UNBOUND]) {
      const i = orderedKeys.indexOf(sk)
      if (i >= 0) return i
    }
    return orderedKeys.length
  }

  const ensureProactiveFirst = () => {
    const i = orderedKeys.indexOf(WORKSPACE_GROUP_PROACTIVE)
    if (i <= 0) return
    orderedKeys.splice(i, 1)
    orderedKeys.unshift(WORKSPACE_GROUP_PROACTIVE)
  }

  const ingestSummary = (incoming: WorkspaceGroupSummary) => {
    const rawKey = String(incoming.workspaceKey || '').trim()
    if (!rawKey) return
    if (isSpecialWorkspaceGroupKey(rawKey)) {
      const prev = summaryByKey.get(rawKey)
      if (!prev) {
        summaryByKey.set(rawKey, incoming)
        orderedKeys.push(rawKey)
      } else {
        summaryByKey.set(rawKey, {
          ...prev,
          sessionCount: Math.max(Number(prev.sessionCount) || 0, Number(incoming.sessionCount) || 0),
          maxUpdatedAt: Math.max(Number(prev.maxUpdatedAt) || 0, Number(incoming.maxUpdatedAt) || 0),
        })
      }
      return
    }
    const nk = normalizeWorkspacePathKey(rawKey)
    const prev = summaryByKey.get(nk)
    if (!prev) {
      summaryByKey.set(nk, { ...incoming, workspaceKey: nk })
      orderedKeys.push(nk)
      return
    }
    summaryByKey.set(nk, {
      ...prev,
      sessionCount: (Number(prev.sessionCount) || 0) + (Number(incoming.sessionCount) || 0),
      maxUpdatedAt: Math.max(Number(prev.maxUpdatedAt) || 0, Number(incoming.maxUpdatedAt) || 0),
      localWorkspaceRoot: prev.localWorkspaceRoot || incoming.localWorkspaceRoot,
    })
  }

  for (const s of summaries) ingestSummary(s)
  ensureProactiveFirst()

  for (const raw of registeredPaths) {
    const path = String(raw || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    if (!path) continue
    const workspaceKey = normalizeWorkspacePathKey(path)
    if (summaryByKey.has(workspaceKey)) continue
    summaryByKey.set(workspaceKey, {
      workspaceKey,
      localWorkspaceRoot: path,
      useVirtualPaths: false,
      sessionCount: 0,
      maxUpdatedAt: 0,
    })
    orderedKeys.splice(insertBeforeSpecialKeys(), 0, workspaceKey)
  }

  if (!summaryByKey.has(WORKSPACE_GROUP_UNBOUND)) {
    summaryByKey.set(WORKSPACE_GROUP_UNBOUND, {
      workspaceKey: WORKSPACE_GROUP_UNBOUND,
      localWorkspaceRoot: null,
      useVirtualPaths: false,
      sessionCount: 0,
      maxUpdatedAt: 0,
    })
    orderedKeys.push(WORKSPACE_GROUP_UNBOUND)
  }

  // 已加载的员工会话可能尚未进入 API summaries（旧后端）；补挂分组避免消失
  if (
    !summaryByKey.has(WORKSPACE_GROUP_PROACTIVE) &&
    (sessionsByKey.get(WORKSPACE_GROUP_PROACTIVE) || []).length > 0
  ) {
    summaryByKey.set(WORKSPACE_GROUP_PROACTIVE, {
      workspaceKey: WORKSPACE_GROUP_PROACTIVE,
      localWorkspaceRoot: null,
      useVirtualPaths: false,
      sessionCount: (sessionsByKey.get(WORKSPACE_GROUP_PROACTIVE) || []).length,
      maxUpdatedAt: 0,
    })
    orderedKeys.unshift(WORKSPACE_GROUP_PROACTIVE)
  }
  ensureProactiveFirst()

  return orderedKeys.map((workspaceKey) => {
    const summary = summaryByKey.get(workspaceKey)!
    const lookupKey = isSpecialWorkspaceGroupKey(workspaceKey)
      ? workspaceKey
      : normalizeWorkspacePathKey(workspaceKey)
    const sessions = sessionsByKey.get(lookupKey) || []
    return summaryToShellGroup({ ...summary, workspaceKey: lookupKey }, sessions)
  })
}

/** 锁定侧栏工作目录顺序：选中/切换会话时不因历史路径变化而跳动 */
export function stabilizeShellWorkspaceGroupOrder(
  groups: ShellWorkspaceGroup[],
  orderRef: { current: string[] },
): ShellWorkspaceGroup[] {
  const byKey = new Map(groups.map((g) => [g.workspaceKey, g]))
  const boundKeys = groups
    .filter((g) => !isSpecialWorkspaceGroupKey(g.workspaceKey))
    .map((g) => g.workspaceKey)

  if (orderRef.current.length === 0) {
    orderRef.current = [...boundKeys]
  } else {
    for (const k of boundKeys) {
      if (!orderRef.current.includes(k)) orderRef.current.push(k)
    }
    orderRef.current = orderRef.current.filter((k) => byKey.has(k))
  }

  const orderedBound = orderRef.current
    .map((k) => byKey.get(k))
    .filter((g): g is ShellWorkspaceGroup => !!g)
  const virtual = byKey.get(WORKSPACE_GROUP_VIRTUAL)
  const unbound = byKey.get(WORKSPACE_GROUP_UNBOUND)
  const proactive = byKey.get(WORKSPACE_GROUP_PROACTIVE)
  const out: ShellWorkspaceGroup[] = []
  if (proactive) out.push(proactive)
  out.push(...orderedBound)
  if (virtual) out.push(virtual)
  if (unbound) out.push(unbound)
  return out
}

export function isProactiveDutySessionKey(sessionKey: string | null | undefined): boolean {
  return parseProactiveSessionKey(sessionKey).kind === 'duty'
}

/**
 * 员工列表：每个员工只露出最新一条值班；更早的值班折进 `folded`。
 * 当前选中的值班始终可见。`expandAll` 时全部展开。
 */
export function splitVisibleAndFoldedDutySessions(
  rows: ShellSidebarSyncRow[],
  opts?: { selectedSessionKey?: string | null; expandAll?: boolean },
): { visible: ShellSidebarSyncRow[]; folded: ShellSidebarSyncRow[] } {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length || opts?.expandAll) return { visible: list, folded: [] }

  const selected = String(opts?.selectedSessionKey || '').trim()
  const latestDutyByAgent = new Map<string, { sk: string; updatedAt: number }>()
  for (const row of list) {
    const sk = String(row.sessionKey || '')
    if (!isProactiveDutySessionKey(sk)) continue
    const code = proactiveAgentCodeFromSessionKey(sk).toLowerCase()
    if (!code) continue
    const ts = Number(row.updatedAt || 0)
    const prev = latestDutyByAgent.get(code)
    if (!prev || ts > prev.updatedAt || (ts === prev.updatedAt && sk.localeCompare(prev.sk) > 0)) {
      latestDutyByAgent.set(code, { sk, updatedAt: ts })
    }
  }

  const keepDuty = new Set([...latestDutyByAgent.values()].map((x) => x.sk))
  if (selected && isProactiveDutySessionKey(selected)) keepDuty.add(selected)

  const visible: ShellSidebarSyncRow[] = []
  const folded: ShellSidebarSyncRow[] = []
  for (const row of list) {
    const sk = String(row.sessionKey || '')
    if (isProactiveDutySessionKey(sk) && !keepDuty.has(sk)) folded.push(row)
    else visible.push(row)
  }
  return { visible, folded }
}
