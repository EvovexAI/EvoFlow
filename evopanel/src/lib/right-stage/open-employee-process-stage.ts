/**
 * 员工任务「执行过程」→ 任务中心右侧栏独立 tab（与工作流同构，单节点）。
 * 不再居中弹层。
 */
import { rightStageStore } from './right-stage-store.js'

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
export function employeeProcessStageTabId(taskId: string): string {
  const tid = String(taskId || '').trim()
  return tid ? `process:${tid}` : ''
}

export function employeeProcessStageTabKey(taskId: string): string {
  const id = employeeProcessStageTabId(taskId)
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
  const title = String(payload.title || '执行过程').trim() || '执行过程'
  const id = employeeProcessStageTabId(tid)
  rightStageStore.show({
    kind: 'employeeProcess',
    id,
    title,
    layout: opts?.layout || 'wide',
    sessionKey: String(opts?.sessionKey || '').trim() || undefined,
    data: {
      taskId: tid,
      agentCode: code,
      roleName: String(payload.roleName || '').trim(),
      title,
      roundId: String(payload.roundId || '').trim(),
      busy: !!payload.busy,
      sessionKey: String(opts?.sessionKey || '').trim(),
    },
  })
  return id
}
