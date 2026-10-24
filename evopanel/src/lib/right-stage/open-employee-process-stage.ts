/**
 * 员工任务「执行过程」→ 右侧栏独立 tab（与工作流同构）。
 * 对话 panel_set：workspace 无 sessionKey；任务中心：task-center:* + tc: id。
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

/** 打开（或激活）员工执行过程 tab。 */
export function openEmployeeProcessInRightStage(
  payload: EmployeeProcessStagePayload,
  opts?: OpenEmployeeProcessStageOpts,
): string {
  const tid = String(payload?.taskId || '').trim()
  const code = String(payload?.agentCode || '').trim()
  if (!tid || !code) return ''
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const title = String(payload.title || '执行过程').trim() || '执行过程'
  const id = employeeProcessStageTabId(tid, sk)
  rightStageStore.show({
    kind: 'employeeProcess',
    id,
    title,
    layout: opts?.layout || 'wide',
    sessionKey: sk,
    data: {
      taskId: tid,
      agentCode: code,
      roleName: String(payload.roleName || '').trim(),
      title,
      roundId: String(payload.roundId || '').trim(),
      busy: !!payload.busy,
    },
  })
  return id
}
