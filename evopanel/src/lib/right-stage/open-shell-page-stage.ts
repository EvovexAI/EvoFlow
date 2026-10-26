/**
 * 右栏挂载壳页面（shell-page）：与菜单同一套 path，非 BrowserPanel。
 */
import { rightStageStore } from './right-stage-store.js'
import { shellPageTabId } from './shell-page-mount-table.js'

export type ShellPageStagePayload = {
  path: string
  title?: string
  mountId?: string
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

/** 打开（或激活）壳页面 tab。id 按 path 去重。 */
export function openShellPageInRightStage(
  payload: ShellPageStagePayload,
  opts?: OpenShellPageStageOpts,
): string {
  const path = normalizePath(payload?.path)
  if (!path) return ''
  const id = shellPageTabId(path)
  if (!id) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const title = String(payload.title || '').trim() || path
  rightStageStore.show({
    kind: 'shell-page',
    id,
    title,
    layout: opts?.layout || payload.layout || 'wide',
    sessionKey: sk,
    data: {
      path,
      route: path,
      mountId: String(payload.mountId || '').trim(),
      title,
    },
  })
  return id
}
