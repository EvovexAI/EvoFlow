/**
 * 壳页面挂载表：与菜单 hash 路径对齐，右栏 shell-page 按 path 挂同款页面模块。
 * 不是 BrowserPanel；未登记的 path 由 ShellPageKind 降级提示 + route 回落。
 */

export type ShellPageMountResult = {
  destroy: () => void
  /** 挂载后解析到的可读标题（员工名 / 任务名等），供右栏标签回写 */
  title?: string
}

export type ShellPageMountOpts = {
  onClose?: () => void
  title?: string
  /** 异步解析到可读标题时回调（任务详情等） */
  onTitle?: (title: string) => void
}

/** 右栏标签绝不直接显示 path；优先实体名，其次按 mountId 给短名。 */
export function resolveShellPageTabTitle(opts: {
  title?: string | null
  entityLabel?: string | null
  path?: string | null
  mountId?: string | null
}): string {
  const looksLikePath = (s: string) =>
    !s ||
    s.startsWith('/') ||
    s.startsWith('#/') ||
    s.startsWith('shell:') ||
    /^https?:\/\//i.test(s)

  for (const raw of [opts.entityLabel, opts.title]) {
    const s = String(raw || '').trim()
    if (!s || looksLikePath(s)) continue
    return s.slice(0, 48)
  }
  const mountId = String(opts.mountId || '').trim()
  if (mountId.startsWith('employees')) return '员工'
  if (mountId.startsWith('tasks') || mountId.startsWith('items')) return '任务'
  if (mountId.startsWith('apps') || mountId.startsWith('workflow')) return '工作流'
  if (mountId.startsWith('knowledge')) return '知识库'
  if (mountId.startsWith('settings') || mountId === 'settings.models') return '设置'
  if (mountId.startsWith('automation') || mountId.includes('cron')) return '自动化'
  const path = String(opts.path || '').trim()
  if (
    path === '/proactive' ||
    path.startsWith('/proactive/') ||
    path === '/employees' ||
    path.startsWith('/employees/')
  ) {
    return '员工'
  }
  if (path.startsWith('/task/')) return '任务'
  if (path.startsWith('/apps')) return '工作流'
  if (path.startsWith('/knowledge')) return '知识库'
  return '页面'
}

export type ShellPageMountFn = (
  host: HTMLElement,
  params: Record<string, string>,
  opts: ShellPageMountOpts,
) => Promise<ShellPageMountResult> | ShellPageMountResult

export type ShellPageMountMatch = {
  mountId: string
  path: string
  params: Record<string, string>
  mount: ShellPageMountFn
}

type Entry = {
  mountId: string
  /** 匹配 path（不含 query）；capture groups → paramNames */
  pattern: RegExp
  paramNames: string[]
  mount: ShellPageMountFn
}

function normalizePath(raw: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (p.startsWith('#')) p = p.slice(1)
  if (!p.startsWith('/')) p = `/${p}`
  // 挂载匹配忽略 query；query 仍可从完整 path 传给页面（若需要）
  p = p.split('?')[0].replace(/\/+$/, '') || '/'
  // 别名：/employees ↔ /proactive（旧 CTA / 口语路由）
  if (p === '/employees') return '/proactive'
  const emp = p.match(/^\/employees\/([^/]+)$/)
  if (emp) return `/proactive/${emp[1]}`
  return p
}

const ENTRIES: Entry[] = [
  {
    mountId: 'employees.board',
    pattern: /^\/proactive$/,
    paramNames: [],
    mount: async (host, _params, opts) => {
      // 右栏用精简名册（头像/名字/状态），不挂全量员工墙
      const mod = await import('../../pages/proactive-roster-compact.js')
      return mod.mountProactiveRosterCompact(host, {
        onClose: opts.onClose,
      })
    },
  },
  {
    mountId: 'employees.detail',
    pattern: /^\/proactive\/([^/]+)$/,
    paramNames: ['code'],
    mount: async (host, params, opts) => {
      const mod = await import('../../pages/proactive-employee.js')
      return mod.mountEmployeePageInto(host, {
        code: params.code,
        onClose: opts.onClose,
      })
    },
  },
  {
    mountId: 'tasks.detail',
    pattern: /^\/task\/([^/]+)$/,
    paramNames: ['id'],
    mount: async (host, params, opts) => {
      const mod = await import('../../pages/task-detail.js')
      return mod.mountTaskDetailInto(host, {
        taskId: params.id,
        onClose: opts.onClose,
        onTitle: opts.onTitle,
      })
    },
  },
]

/** 解析挂载表；未命中返回 null（勿用 BrowserPanel 顶替）。 */
export function matchShellPagePath(rawPath: string): ShellPageMountMatch | null {
  const path = normalizePath(rawPath)
  if (!path || path === '/') return null
  // 工作看板深链暂未接；列表用 /proactive
  if (path === '/proactive/board') return null
  for (const entry of ENTRIES) {
    const m = path.match(entry.pattern)
    if (!m) continue
    if (entry.mountId === 'employees.detail' && (m[1] === 'board' || m[1] === 'approvals')) {
      continue
    }
    const params: Record<string, string> = {}
    entry.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(String(m[i + 1] || '').trim())
    })
    return { mountId: entry.mountId, path, params, mount: entry.mount }
  }
  return null
}

export function shellPageTabId(path: string): string {
  const p = normalizePath(path)
  return p ? `shell:${p}` : ''
}
