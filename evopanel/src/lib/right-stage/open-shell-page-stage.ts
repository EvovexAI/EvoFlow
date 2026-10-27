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
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

export type OpenShellPageStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

function normalizePath(raw: string): string {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (p.startsWith('#')) p = p.slice(1)
  if (!p.startsWith('/')) p = `/${p}`
  return p
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
  // 已挂同一 path：只激活/展开；若新标题更可读则回写（不因 path 覆盖好名字）
  const existing = rightStageStore.findTab(`shell-page:${id}`)
  if (existing && String(existing.data?.path || existing.data?.route || '').trim() === path) {
    const prevTitle = String(existing.title || '').trim()
    const prevLooksGeneric =
      !prevTitle ||
      prevTitle.startsWith('/') ||
      prevTitle === '页面' ||
      prevTitle === '员工' ||
      prevTitle === '任务' ||
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
      },
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
    },
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
