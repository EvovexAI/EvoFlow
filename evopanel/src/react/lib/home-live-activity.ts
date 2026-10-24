/**
 * Workbench「正在处理」— runtime liveness rows (chat / employee / automation / workflow).
 * Orthogonal to Task Center lifecycle status.
 */

export type HomeLiveKind = 'chat' | 'employee' | 'automation' | 'workflow'

export type HomeLiveHealth = 'live' | 'stale'

export type HomeLiveItem = {
  id: string
  kind: HomeLiveKind
  title: string
  meta: string
  health: HomeLiveHealth
  statusLabel: string
  href?: string
  /** Open chat session via shell event instead of hash */
  sessionKey?: string
  time?: string
}

export const HOME_LIVE_KIND_ZH: Record<HomeLiveKind, string> = {
  chat: '对话',
  employee: '员工',
  automation: '自动化',
  workflow: '工作流',
}

function asArray(data: unknown): any[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.active_sessions)) return obj.active_sessions
    if (Array.isArray(obj.sessions)) return obj.sessions
    if (Array.isArray(obj.runs)) return obj.runs
    if (Array.isArray(obj.items)) return obj.items
    if (Array.isArray(obj.data)) return obj.data
  }
  return []
}

function parseTime(raw: unknown): Date | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(String(raw))
  return Number.isNaN(d.getTime()) ? null : d
}

function formatShortTime(raw: unknown): string {
  const d = parseTime(raw)
  if (!d) return ''
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (d >= startToday) {
    return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function classifySessionKey(sessionKey: string): HomeLiveKind {
  const sk = String(sessionKey || '').trim()
  if (sk.startsWith('automation:')) return 'automation'
  if (sk.startsWith('proactive:')) return 'employee'
  return 'chat'
}

function agentCodeFromProactiveKey(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk.startsWith('proactive:')) return ''
  const rest = sk.slice('proactive:'.length)
  const code = rest.split(':')[0] || ''
  return code.trim()
}

function automationIdFromKey(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk.startsWith('automation:')) return ''
  const parts = sk.split(':')
  return String(parts[1] || '').trim()
}

function shortSessionLabel(sessionKey: string): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return '会话'
  if (sk.length <= 28) return sk
  return `${sk.slice(0, 12)}…${sk.slice(-8)}`
}

export type BuildHomeLiveInput = {
  activeSessions: unknown
  roles: any[]
  roleBusyByCode: Record<string, any>
  automations: any[]
  /** Task Center rows already filtered or full list — used for workflow running */
  tasks: any[]
  isTaskRunning: (status: unknown) => boolean
  taskSourceKey: (t: any) => string
  taskTitle: (t: any) => string
  taskHref: (t: any) => string
  formatTaskSourceZh: (src: unknown) => string
}

/**
 * Merge live signals into a deduped list for the home strip.
 * Prefer true runtime (sessions / busy) over lifecycle-only task rows.
 */
export function buildHomeLiveItems(input: BuildHomeLiveInput): HomeLiveItem[] {
  const items: HomeLiveItem[] = []
  const seenSession = new Set<string>()
  const seenEmployee = new Set<string>()
  const seenTask = new Set<string>()

  const autoNameById = new Map<string, string>()
  for (const a of input.automations || []) {
    const id = String(a?.id || a?.task_id || '').trim()
    if (!id) continue
    autoNameById.set(id, String(a?.name || a?.title || id).trim() || id)
  }

  const roleNameByCode = new Map<string, string>()
  for (const r of input.roles || []) {
    const code = String(r?.agent_code || r?.code || '').trim()
    if (!code) continue
    const name = String(r?.role_name || r?.name || r?.display_name || code).trim() || code
    roleNameByCode.set(code, name)
  }

  for (const row of asArray(input.activeSessions)) {
    const sessionKey = String(row?.session_key || row?.sessionKey || '').trim()
    if (!sessionKey || seenSession.has(sessionKey)) continue
    seenSession.add(sessionKey)

    const kind = classifySessionKey(sessionKey)
    const titleFromApi = String(row?.title || '').trim()
    const agentId = String(row?.agent_id || row?.agentId || '').trim()
    let title = titleFromApi || shortSessionLabel(sessionKey)
    let meta = HOME_LIVE_KIND_ZH[kind]
    let href: string | undefined
    let openSession = sessionKey

    if (kind === 'employee') {
      const code = agentCodeFromProactiveKey(sessionKey) || agentId
      if (code) {
        seenEmployee.add(code)
        const name = roleNameByCode.get(code) || code
        if (!titleFromApi) title = `${name} · 值班中`
        meta = `员工 · ${name}`
        href = `#/proactive/${encodeURIComponent(code)}`
      }
    } else if (kind === 'automation') {
      const autoId = automationIdFromKey(sessionKey)
      const autoName = (autoId && autoNameById.get(autoId)) || autoId || '自动化'
      if (!titleFromApi) title = autoName
      meta = `自动化${autoId ? ` · ${autoId}` : ''}`
      href = autoId ? `#/automation?task=${encodeURIComponent(autoId)}` : '#/automation?tab=runs'
    } else {
      meta = agentId ? `对话 · ${agentId}` : '对话'
    }

    items.push({
      id: `session:${sessionKey}`,
      kind,
      title,
      meta,
      health: 'live',
      statusLabel: '在跑',
      href,
      sessionKey: openSession,
      time: formatShortTime(row?.updated_at || row?.updatedAt),
    })
  }

  for (const [code, busyRes] of Object.entries(input.roleBusyByCode || {})) {
    const agentCode = String(code || '').trim()
    if (!agentCode || seenEmployee.has(agentCode)) continue
    const busy = !!(busyRes?.busy || busyRes?.is_busy)
    if (!busy) continue
    seenEmployee.add(agentCode)

    const name = roleNameByCode.get(agentCode) || agentCode
    const sk = String(busyRes?.current_session_key || busyRes?.currentSessionKey || '').trim()
    if (sk) seenSession.add(sk)

    items.push({
      id: `employee:${agentCode}`,
      kind: 'employee',
      title: `${name} · 处理中`,
      meta: '智能体员工',
      health: 'live',
      statusLabel: '在跑',
      href: `#/proactive/${encodeURIComponent(agentCode)}`,
      sessionKey: sk || undefined,
      time: '',
    })
  }

  for (const t of input.tasks || []) {
    if (!input.isTaskRunning(t?.status)) continue
    const src = input.taskSourceKey(t)
    if (src !== 'workflow') continue
    const id = String(t?.id || t?.task_id || '').trim()
    if (!id || seenTask.has(id)) continue
    seenTask.add(id)

    const agent = String(t?.assigned_agent_name || t?.agent_name || t?.role_name || '').trim()
    items.push({
      id: `workflow-task:${id}`,
      kind: 'workflow',
      title: input.taskTitle(t),
      meta: [input.formatTaskSourceZh(t?.source || t?.task_source) || '工作流', agent]
        .filter(Boolean)
        .join(' · '),
      health: 'live',
      statusLabel: '执行中',
      href: input.taskHref(t),
      time: formatShortTime(t?.updated_at || t?.updatedAt || t?.created_at),
    })
  }

  const kindOrder: Record<HomeLiveKind, number> = {
    chat: 0,
    employee: 1,
    automation: 2,
    workflow: 3,
  }
  items.sort((a, b) => {
    const ko = kindOrder[a.kind] - kindOrder[b.kind]
    if (ko !== 0) return ko
    return String(b.time || '').localeCompare(String(a.time || ''))
  })

  return items
}

export function openHomeLiveItem(item: HomeLiveItem): void {
  // Chat / automation / employee with a live session → jump into that thread.
  if (item.sessionKey && item.kind !== 'workflow') {
    window.dispatchEvent(
      new CustomEvent('evopanel:shell-select-session', {
        detail: { sessionKey: item.sessionKey },
      }),
    )
    return
  }
  if (item.href) {
    window.location.hash = item.href.startsWith('#') ? item.href.slice(1) : item.href
  }
}
