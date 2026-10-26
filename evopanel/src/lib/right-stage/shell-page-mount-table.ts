/**
 * 壳页面挂载表：与菜单 hash 路径对齐，右栏 shell-page 按 path 挂同款页面模块。
 * 不是 BrowserPanel；未登记的 path 由 ShellPageKind 降级提示 + route 回落。
 */

export type ShellPageMountResult = { destroy: () => void }

export type ShellPageMountOpts = {
  onClose?: () => void
  title?: string
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
  return p.split('?')[0].replace(/\/+$/, '') || '/'
}

const ENTRIES: Entry[] = [
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
      })
    },
  },
]

/** 解析挂载表；未命中返回 null（勿用 BrowserPanel 顶替）。 */
export function matchShellPagePath(rawPath: string): ShellPageMountMatch | null {
  const path = normalizePath(rawPath)
  if (!path || path === '/') return null
  // 员工墙 /proactive、board 等暂未接 mount 适配器
  if (path === '/proactive' || path === '/proactive/board') return null
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
