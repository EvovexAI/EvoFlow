/**
 * 员工任务「执行过程」→ 右侧栏独立 tab（与工作流同构）。
 * 对话 panel_set：workspace 无 sessionKey；任务中心：task-center:* + tc: id。
 *
 * 渲染权威：V4EmployeeProcessPane（勿再接 ProactiveLiveProcessHost / mode=panel）。
 */
import { rightStageStore } from './right-stage-store.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'

export type EmployeeProcessStagePayload = {
  taskId: string
  agentCode: string
  roleName?: string
  title?: string
  roundId?: string
  busy?: boolean
}

export type OpenEmployeeProcessStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
}

function looksLikePathOrGeneric(title: string): boolean {
  const t = String(title || '').trim()
  if (!t) return true
  if (t === '执行过程' || t === '查看进度' || t === '进度') return true
  if (t.startsWith('/') || t.startsWith('#/')) return true
  return false
}

/** 标签优先员工名（roleName），勿用任务名 /「执行过程」占位。 */
export function resolveEmployeeProcessTabTitle(payload: {
  title?: string | null
  roleName?: string | null
  agentCode?: string | null
}): string {
  for (const raw of [payload.roleName, payload.title]) {
    const s = String(raw || '').trim()
    if (!s || looksLikePathOrGeneric(s)) continue
    return s.slice(0, 48)
  }
  const code = String(payload.agentCode || '').trim()
  return code || '执行过程'
}

/** store tabKey = `employeeProcess:${id}` */
export function employeeProcessStageTabId(taskId: string, sessionKey?: string | null): string {
  const tid = String(taskId || '').trim()
  if (!tid) return ''
  const base = `process:${tid}`
  return isTaskCenterStageSessionKey(sessionKey) ? `tc:${base}` : base
}

export function employeeProcessStageTabKey(taskId: string, sessionKey?: string | null): string {
  const id = employeeProcessStageTabId(taskId, sessionKey)
  return id ? `employeeProcess:${id}` : ''
}

/** 打开（或激活）员工执行过程 tab。标签用员工名。 */
export function openEmployeeProcessInRightStage(
  payload: EmployeeProcessStagePayload,
  opts?: OpenEmployeeProcessStageOpts,
): string {
  const tid = String(payload?.taskId || '').trim()
  const code = String(payload?.agentCode || '').trim()
  if (!tid || !code) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const roleName = String(payload.roleName || '').trim()
  const title = resolveEmployeeProcessTabTitle({
    title: payload.title,
    roleName,
    agentCode: code,
  })
  const id = employeeProcessStageTabId(tid, sk)
  const key = `employeeProcess:${id}`
  const existing = rightStageStore.findTab(key)
  // 已有可读名字时别被「执行过程」盖掉
  const keepTitle =
    existing &&
    !looksLikePathOrGeneric(String(existing.title || '')) &&
    looksLikePathOrGeneric(String(payload.title || ''))
      ? String(existing.title || '').trim()
      : title

  rightStageStore.show({
    kind: 'employeeProcess',
    id,
    title: keepTitle,
    layout: opts?.layout || 'wide',
    sessionKey: sk,
    data: {
      taskId: tid,
      agentCode: code,
      roleName: roleName || String(existing?.data?.roleName || '').trim(),
      title: keepTitle,
      roundId: String(payload.roundId || '').trim(),
      busy: !!payload.busy,
    },
  })
  return id
}

/** 解析到真实岗位名后回写标签。 */
export function patchEmployeeProcessTabTitle(
  taskId: string,
  title: string,
  opts?: { sessionKey?: string | null; roleName?: string },
): void {
  const nice = resolveEmployeeProcessTabTitle({
    title,
    roleName: opts?.roleName,
  })
  if (!nice || looksLikePathOrGeneric(nice)) return
  const key = employeeProcessStageTabKey(taskId, opts?.sessionKey)
  if (!key) return
  rightStageStore.patchTab(key, {
    title: nice,
    data: {
      title: nice,
      ...(opts?.roleName ? { roleName: opts.roleName } : { roleName: nice }),
    },
  })
}
