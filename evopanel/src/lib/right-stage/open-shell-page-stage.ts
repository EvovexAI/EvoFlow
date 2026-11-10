/**
 * 右栏挂载壳页面（shell-page）：与菜单同一套 path，非 BrowserPanel。
 */
import { rightStageStore } from './right-stage-store.js'
import { resolveShellPageTabTitle, shellPageTabId } from './shell-page-mount-table.js'

export type ShellPageStagePayload = {
  path: string
  title?: string
  mountId?: string
  entityLabel?: string
  focusId?: string
  /** 员工详情签：页签旁显示智能体头像 */
  agentCode?: string
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

export type OpenShellPageStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
  /**
   * 用户显式打开（点按钮/卡片）时传 true：清掉收起锁并展开右栏。
   * 不传 = 沿用 store 语义（用户收起锁定时只写签不撑开）——自动开栏勿传。
   */
  forceExpand?: boolean
}

function normalizePath(raw: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (p.startsWith('#')) p = p.slice(1)
  if (!p.startsWith('/')) p = `/${p}`
  p = p.split('?')[0].replace(/\/+$/, '') || '/'
  // 与挂载表一致：/employees → /proactive
  if (p === '/employees') return '/proactive'
  const emp = p.match(/^\/employees\/([^/]+)$/)
  if (emp) return `/proactive/${emp[1]}`
  return p
}

/** `/proactive/:code` → agent_code（页签头像兜底） */
export function agentCodeFromShellPagePath(path: string): string {
  const p = normalizePath(path)
  const m = p.match(/^\/proactive\/([^/]+)$/)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1]).trim()
  } catch {
    return String(m[1] || '').trim()
  }
}

/** 打开（或激活）壳页面 tab。id 按 path 去重；标签用实体名，不用 path。 */
export function openShellPageInRightStage(
  payload: ShellPageStagePayload,
  opts?: OpenShellPageStageOpts,
): string {
  const path = normalizePath(payload?.path)
  if (!path) return ''
  const id = shellPageTabId(path)
  if (!id) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const mountId = String(payload.mountId || '').trim()
  const layout = opts?.layout || payload.layout || 'wide'
  const title = resolveShellPageTabTitle({
    title: payload.title,
    entityLabel: payload.entityLabel,
    path,
    mountId,
  })
  const focusId = String(payload.focusId || '').trim()
  const forceExpand = opts?.forceExpand === true
  const agentCode =
    String(payload.agentCode || '').trim() || agentCodeFromShellPagePath(path)
  // 已挂同一 path：只激活/展开；若新标题更可读则回写（不因 path 覆盖好名字）
  const existing = rightStageStore.findTab(`shell-page:${id}`)
  if (existing && String(existing.data?.path || existing.data?.route || '').trim() === path) {
    const prevTitle = String(existing.title || '').trim()
    const prevLooksGeneric =
      !prevTitle ||
      prevTitle.startsWith('/') ||
      prevTitle === '页面' ||
      prevTitle === '员工' ||
      prevTitle === 'BOT' ||
      prevTitle === '任务' ||
      prevTitle === '待办' ||
      prevTitle === '工作流'
    const nextTitle = prevLooksGeneric && title && title !== prevTitle ? title : prevTitle || title
    rightStageStore.show({
      kind: 'shell-page',
      id,
      title: nextTitle,
      layout: existing.layout || layout,
      sessionKey: sk,
      data: {
        path,
        route: path,
        mountId: String(existing.data?.mountId || mountId).trim(),
        title: nextTitle,
        entityLabel: String(
          payload.entityLabel || existing.data?.entityLabel || '',
        ).trim(),
        focusId: focusId || String(existing.data?.focusId || '').trim(),
        agentCode:
          agentCode ||
          String(existing.data?.agentCode || existing.data?.agent_code || '').trim(),
      },
      forceExpand,
    })
    return id
  }
  rightStageStore.show({
    kind: 'shell-page',
    id,
    title,
    layout,
    sessionKey: sk,
    data: {
      path,
      route: path,
      mountId,
      title,
      entityLabel: String(payload.entityLabel || '').trim(),
      focusId,
      ...(agentCode ? { agentCode } : {}),
    },
    forceExpand,
  })
  return id
}

/** 挂载完成后用真实名称回写标签（员工 role_name / 任务 name）。 */
export function patchShellPageTabTitle(path: string, title: string): void {
  const p = normalizePath(path)
  const id = shellPageTabId(p)
  if (!id || !title.trim()) return
  const key = `shell-page:${id}`
  const next = resolveShellPageTabTitle({ title, path: p })
  if (!next || next.startsWith('/')) return
  rightStageStore.patchTab(key, {
    title: next,
    data: { title: next, entityLabel: next },
  })
}
