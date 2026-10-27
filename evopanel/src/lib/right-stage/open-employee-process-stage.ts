/**
 * 员工任务「执行过程」→ 右侧栏独立 tab（与工作流同构）。
 * 对话 panel_set：钉触发会话 sessionKey；任务中心：task-center:* + tc: id。
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
  /** 员工对话 session_key（chat_send / 续聊）；写入 tab.data 供面板直接发送 */
  employeeSessionKey?: string
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

/**
 * store tab id 片段。有真实 taskId 用它；派发/唤醒常无 task → `live:{agentCode}`，
 * 仍能开右栏跟岗对话（V4EmployeeProcessPane 按 agentCode 拉 meta）。
 */
export function employeeProcessStageTabId(
  taskId: string,
  sessionKey?: string | null,
  agentCode?: string | null,
): string {
  const tid = String(taskId || '').trim()
  const code = String(agentCode || '').trim()
  const baseId = tid || (code ? `live:${code}` : '')
  if (!baseId) return ''
  const base = `process:${baseId}`
  return isTaskCenterStageSessionKey(sessionKey) ? `tc:${base}` : base
}

export function employeeProcessStageTabKey(
  taskId: string,
  sessionKey?: string | null,
  agentCode?: string | null,
): string {
  const id = employeeProcessStageTabId(taskId, sessionKey, agentCode)
  return id ? `employeeProcess:${id}` : ''
}

/** `live:{code}` 是无真实 task 时的跟岗占位，不当作 proactive task session。 */
export function isLiveEmployeeProcessTaskId(taskId: string | null | undefined): boolean {
  const tid = String(taskId || '').trim()
  return !tid || tid.startsWith('live:')
}

/** 打开（或激活）员工执行过程 tab。标签用员工名。有 agent 即可，taskId 可空 / live:。 */
export function openEmployeeProcessInRightStage(
  payload: EmployeeProcessStagePayload,
  opts?: OpenEmployeeProcessStageOpts,
): string {
  const rawTaskId = String(payload?.taskId || '').trim()
  const code = String(payload?.agentCode || '').trim()
  if (!code) return ''
  const live = isLiveEmployeeProcessTaskId(rawTaskId)
  const realTaskId = live ? '' : rawTaskId
  const tabBase = live ? rawTaskId || `live:${code}` : rawTaskId
  const sk = String(opts?.sessionKey || '').trim() || undefined
  const roleName = String(payload.roleName || '').trim()
  const title = resolveEmployeeProcessTabTitle({
    title: payload.title,
    roleName,
    agentCode: code,
  })
  const id = employeeProcessStageTabId(tabBase, sk, code)
  if (!id) return ''
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
      // 跟岗占位不写入 data.taskId，避免拼出假的 proactive:…:task:live-…
      taskId: realTaskId,
      agentCode: code,
      roleName: roleName || String(existing?.data?.roleName || '').trim(),
      title: keepTitle,
      roundId: String(payload.roundId || '').trim(),
      busy: payload.busy !== false,
      employeeSessionKey:
        String(payload.employeeSessionKey || existing?.data?.employeeSessionKey || '').trim() ||
        undefined,
    },
  })
  return id
}

/** 解析到真实岗位名后回写标签。 */
export function patchEmployeeProcessTabTitle(
  taskId: string,
  title: string,
  opts?: { sessionKey?: string | null; roleName?: string; agentCode?: string },
): void {
  const nice = resolveEmployeeProcessTabTitle({
    title,
    roleName: opts?.roleName,
  })
  if (!nice || looksLikePathOrGeneric(nice)) return
  const key = employeeProcessStageTabKey(taskId, opts?.sessionKey, opts?.agentCode)
  if (!key) return
  rightStageStore.patchTab(key, {
    title: nice,
    data: {
      title: nice,
      ...(opts?.roleName ? { roleName: opts.roleName } : { roleName: nice }),
    },
  })
}
