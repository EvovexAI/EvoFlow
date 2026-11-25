/**
 * 员工任务「执行过程」→ 右侧栏独立 tab（与工作流同构）。
 * 对话 panel_set：钉触发会话 sessionKey；任务中心：task-center:* + tc: id。
 *
 * 渲染权威：V4EmployeeProcessPane（勿再接 ProactiveLiveProcessHost / mode=panel）。
 */
import { rightStageStore } from './right-stage-store.js'
import { isTaskCenterStageSessionKey } from './task-center-stage-key.js'
import { logRightStageTrigger } from './panel-set-debug-log.js'

export type EmployeeProcessStagePayload = {
  taskId: string
  agentCode: string
  roleName?: string
  title?: string
  roundId?: string
  /**
   * 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
   * 本次派发时刻（后端 dispatched_at）。roundId 在派单路径恒为空，故用这个
   * 「每轮必变且不参与会话键拼接」的值判「是否换了新一轮」。
   */
  roundStamp?: string
  busy?: boolean
  /** 员工对话 session_key（chat_send / 续聊）；写入 tab.data 供面板直接发送 */
  employeeSessionKey?: string
  /**
   * 平台 chat_send 排队的首条用户消息。面板挂载后走与输入框同一套 handleSend
   * （ensureThread → chatSend），不要在 sync 里另开一条发送链路。
   */
  pendingSendMessage?: string
}

export type OpenEmployeeProcessStageOpts = {
  sessionKey?: string | null
  layout?: 'half' | 'wide' | 'narrow' | 'workspace-write'
  /**
   * 用户显式打开（点成员卡/员工页按钮）时传 true：清掉收起锁并展开右栏。
   * 不传 = 沿用 store 语义（用户收起锁定时只写签不撑开）——自动开栏（唤醒/chat_send 同步）勿传。
   */
  forceExpand?: boolean
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
  const code = String(payload.agentCode || '').trim()
  for (const raw of [payload.roleName, payload.title]) {
    const s = String(raw || '').trim()
    if (!s || looksLikePathOrGeneric(s)) continue
    // 不要用 agent_code 冒充标题（如 evoflow-fullstack-lead）
    if (code && s.toLowerCase() === code.toLowerCase()) continue
    return s.slice(0, 48)
  }
  return '执行过程'
}

/**
 * store tab id 片段。
 *
 * - 对话侧（主聊 / 部门群）：**一人一签** `process:live:{agentCode}`。
 *   若按 wake 出来的真实 taskId 建签，同员工每次 chat_send 都会新开一签，
 *   多员工续聊时标签条看起来像「没有 / 点不回去」。
 * - 任务中心：仍按 task 拆签（`tc:process:{taskId}`），详情页要对准那一单。
 */
export function employeeProcessStageTabId(
  taskId: string,
  sessionKey?: string | null,
  agentCode?: string | null,
): string {
  const tid = String(taskId || '').trim()
  const code = String(agentCode || '').trim()
  if (isTaskCenterStageSessionKey(sessionKey)) {
    const baseId = tid || (code ? `live:${code}` : '')
    if (!baseId) return ''
    return `tc:process:${baseId}`
  }
  // 对话侧：有 agent 就按人钉签；无 code 时才退回 taskId（兼容旧调用）
  if (code) return `process:live:${code}`
  if (!tid) return ''
  return `process:${tid}`
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

  // 收掉同人旧签（历史上按 taskId 建的 process:{uuid}），避免标签条挤满同一员工
  if (!isTaskCenterStageSessionKey(sk)) {
    const snap = rightStageStore.getSnapshot()
    for (const t of snap.tabs || []) {
      if (t.kind !== 'employeeProcess') continue
      const tKey = `employeeProcess:${t.id}`
      if (tKey === key) continue
      const tCode = String(t.data?.agentCode || t.data?.agent_code || '').trim()
      if (tCode !== code) continue
      // 同归属会话（或都无归属）才收，避免误关别的会话记忆里的签
      const tSk = String(t.sessionKey || '').trim()
      const owner = String(sk || '').trim()
      if (owner && tSk && tSk !== owner) continue
      rightStageStore.closeTab(tKey)
    }
  }

  // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：换轮判据从「只看 roundId」扩成 roundId **或** roundStamp。
  // 为什么：roundId 在派单路径恒为空（后端 in-process 分支只回调用方传入的
  // round_id，真实 preview_round 在后台任务里不回传），只靠它判等于死代码——
  // 派了新任务、右栏仍死盯用户上次手挑的历史对话（实测 task:2611201809_4db6
  // running，面板显示上一轮『提交代码推送』）。roundStamp 取本轮 dispatched_at，
  // 每轮必变，且不参与会话键拼接。同一轮重开（stamp 相同）仍继承，保住手选。
  const prevRoundId = String(existing?.data?.roundId || '').trim()
  const nextRoundId = String(payload.roundId || '').trim()
  const prevStamp = String(existing?.data?.roundStamp || '').trim()
  const nextStamp = String(payload.roundStamp || '').trim()
  const roundChanged =
    (Boolean(nextRoundId) && nextRoundId !== prevRoundId) || (Boolean(nextStamp) && nextStamp !== prevStamp)
  const employeeSessionKey =
    String(payload.employeeSessionKey || (roundChanged ? '' : existing?.data?.employeeSessionKey) || '').trim() ||
    undefined
  const pendingSendMessage =
    String(payload.pendingSendMessage || '').trim() ||
    String(existing?.data?.pendingSendMessage || '').trim() ||
    undefined
  rightStageStore.show({
    kind: 'employeeProcess',
    id,
    title: keepTitle,
    layout: opts?.layout || 'wide',
    sessionKey: sk,
    forceExpand: opts?.forceExpand === true,
    data: {
      // 跟岗占位不写入 data.taskId，避免拼出假的 proactive:…:task:live-…
      taskId: realTaskId,
      agentCode: code,
      roleName: roleName || String(existing?.data?.roleName || '').trim(),
      title: keepTitle,
      roundId: String(payload.roundId || '').trim(),
      // 【self-evolution-bot · 2026-11-20 · 第95轮 · 模型:deepseek-v4.1-flash-1017】
      // 保留上一轮的 stamp 时不能覆盖成空：本轮 payload 没带 stamp（如用户手挑会话
      // 重开同一签）就沿用旧值，否则下次比较会误判成「换轮」而清掉手选会话。
      roundStamp: nextStamp || prevStamp || '',
      busy: payload.busy !== false,
      employeeSessionKey,
      pendingSendMessage,
    },
  })
  logRightStageTrigger(
    'openEmployeeProcessInRightStage',
    {
      id,
      key,
      agentCode: code,
      taskId: realTaskId || null,
      live,
      title: keepTitle,
      roleName: roleName || null,
      ownerSessionKey: sk || null,
      employeeSessionKey: employeeSessionKey || null,
      pendingSendLen: pendingSendMessage ? pendingSendMessage.length : 0,
      hadExisting: Boolean(existing),
    },
    { store: rightStageStore },
  )
  return id
}

/**
 * 部门群聊：预写员工跟岗签（不强制撑开右栏）。
 * 群聊唤醒默认不自动展开侧栏；用户点「查看实时过程」走 {@link openEmployeeProcessInRightStage}
 * 并传 `forceExpand: true`。
 */
export function openDeptGroupWakeProcessInRightStage(input: {
  deptId: string
  agentCode: string
  roleName?: string
  /** 主壳会话（dept:{id}:chat），钉标签归属 */
  shellSessionKey?: string | null
  employeeSessionKey?: string | null
  /** 唤醒深度（保留入参兼容；不再据此 forceExpand） */
  depth?: number
}): string {
  const code = String(input.agentCode || '').trim()
  if (!code) return ''
  const roleName = String(input.roleName || '').trim() || code
  const ownerSk = String(input.shellSessionKey || '').trim()
  const employeeSk = String(input.employeeSessionKey || '').trim()
  return openEmployeeProcessInRightStage(
    {
      taskId: `live:${code}`,
      agentCode: code,
      roleName,
      title: roleName,
      busy: true,
      employeeSessionKey: employeeSk || undefined,
    },
    {
      sessionKey: ownerSk || undefined,
      layout: 'wide',
      forceExpand: false,
    },
  )
}

/** 面板消费完 pending 首发后清掉，避免切回页签重复发送。 */
export function clearEmployeeProcessPendingSend(
  taskId: string,
  opts?: { sessionKey?: string | null; agentCode?: string },
): void {
  const key = employeeProcessStageTabKey(taskId, opts?.sessionKey, opts?.agentCode)
  if (!key) return
  rightStageStore.patchTab(key, {
    data: { pendingSendMessage: undefined },
  })
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
