/**
 * 状态面板「进程」区聚合模型。
 *
 * 把三类异构运行态收敛成一条有序列表，供面板列表 / 胶囊摘要共用：
 * - terminal  流式终端（stream.terminalStreams）
 * - agent     子智能体（stream.subagentTasks）
 * - workflow  协作子任务（GET /tasks → subtasks，主任务作为分组头不单列）
 *
 * 纯函数，无 React 依赖，可单测。
 */

import { formatTaskStatusZh, toUnifiedTaskStatus } from '../../lib/task-status-label.js'
import type { BackgroundWorkStreamItem, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'

export type ProcessKind = 'terminal' | 'agent' | 'workflow'

/** 统一进程态：面板按它选图标 / 颜色 / 计数 */
export type ProcessState = 'running' | 'completed' | 'failed' | 'cancelled' | 'pending'

export type ProcessItem = {
  id: string
  kind: ProcessKind
  /** 主标题：命令行 / 子智能体描述 / 子任务名 */
  label: string
  state: ProcessState
  /** 副标题：次级信息（岗位、错误摘要） */
  detail?: string
  /** 点击定位用的原始载荷（由调用方决定怎么用） */
  source: TerminalStreamTask | SubagentStreamTask | { subtaskId?: string; name?: string }
  /** ZCode background work id，用于停止和详情查询 */
  workId?: string
  startedAt?: number
  cancellable?: boolean
}

export type ProcessSummary = {
  items: ProcessItem[]
  /** 面板头部「已完成/总数」计数 */
  completed: number
  total: number
  running: number
  failed: number
  /** 胶囊态要显示的一行摘要 */
  capsuleLabel: string
  capsuleState: ProcessState
}

export type ProcessInput = {
  terminalStreams?: Record<string, TerminalStreamTask> | null
  subagentTasks?: Record<string, SubagentStreamTask> | null
  /** GET /tasks 的 subtasks（collab 子任务快照） */
  workflowSubtasks?: Array<{
    subtaskId?: string
    name?: string
    status?: string
    assignedAgent?: string
    assignedAgentDisplay?: string
  }> | null
  /** ZCode backgroundWorks（kind=bash）。面板只展示 status=running。 */
  backgroundWorks?: Record<string, BackgroundWorkStreamItem> | null
}

/** 终端命令行压到单行、限长，避免长命令撑破面板 */
function compactCommand(raw: string, max = 72): string {
  const oneLine = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

function subagentState(t: SubagentStreamTask): ProcessState {
  const phase = String(t?.phase || '').trim().toLowerCase()
  if (phase === 'running') return 'running'
  if (phase === 'failed' || phase === 'timed_out') return 'failed'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'completed') return 'completed'
  return 'running'
}

function workflowState(status: string | undefined): ProcessState {
  const u = toUnifiedTaskStatus(status)
  if (u === 'completed') return 'completed'
  if (u === 'failed') return 'failed'
  if (u === 'cancelled') return 'cancelled'
  if (u === 'running') return 'running'
  if (u === 'planning') return 'running'
  return 'pending'
}

function firstNonEmpty(...vals: Array<unknown>): string {
  for (const v of vals) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return ''
}

/** 同一 subtask 可能同时有流式快照和落库快照：按 id 合并，流式态优先 */
function mergeById(items: ProcessItem[]): ProcessItem[] {
  const byId = new Map<string, ProcessItem>()
  for (const it of items) {
    const prev = byId.get(it.id)
    if (!prev) {
      byId.set(it.id, it)
      continue
    }
    // running 优先于终态：流式还没落终态时不要被快照盖成已完成
    const keepNew = prev.state !== 'running' && it.state === 'running'
    byId.set(it.id, keepNew ? { ...it, label: it.label || prev.label } : prev)
  }
  return [...byId.values()]
}

const STATE_ORDER: Record<ProcessState, number> = {
  running: 0,
  failed: 1,
  pending: 2,
  cancelled: 3,
  completed: 4,
}

export function buildProcessItems(input: ProcessInput): ProcessItem[] {
  const items: ProcessItem[] = []

  // ZCode「终端」区只列 running background bash；前台/已结束的终端留在聊天卡片里。
  for (const work of Object.values(input.backgroundWorks || {})) {
    if (!work || work.status !== 'running') continue
    const toolCallId = String(work.toolCallId || work.workId || '').trim()
    const command = compactCommand(work.command || work.title || '')
    items.push({
      id: `bash:${work.workId}`,
      kind: 'terminal',
      label: command || '终端',
      state: 'running',
      workId: work.workId,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
      source: {
        toolCallId,
        command: work.command || work.title || '',
        phase: 'running',
      } as TerminalStreamTask,
    })
  }

  for (const a of Object.values(input.subagentTasks || {})) {
    if (!a) continue
    const label = firstNonEmpty(a.description, a.subagentType, a.taskId) || '子智能体'
    items.push({
      id: `agent:${a.taskId}`,
      kind: 'agent',
      label,
      state: subagentState(a),
      detail: firstNonEmpty(a.progressHint, a.subagentType) || undefined,
      source: a,
    })
  }

  for (const s of input.workflowSubtasks || []) {
    const sid = firstNonEmpty(s?.subtaskId)
    if (!sid) continue
    items.push({
      id: `workflow:${sid}`,
      kind: 'workflow',
      label: firstNonEmpty(s?.name, sid),
      state: workflowState(s?.status),
      detail: firstNonEmpty(s?.assignedAgentDisplay, s?.assignedAgent) || undefined,
      source: { subtaskId: sid, name: s?.name },
    })
  }

  const merged = mergeById(items)
  merged.sort((a, b) => {
    const d = STATE_ORDER[a.state] - STATE_ORDER[b.state]
    if (d !== 0) return d
    return a.id.localeCompare(b.id)
  })
  return merged
}

/** 胶囊摘要：优先报「正在跑什么」，空闲时报最后一个结果 */
function capsuleLabelOf(items: ProcessItem[], idleText: string): { label: string; state: ProcessState } {
  const running = items.find((i) => i.state === 'running')
  if (running) return { label: running.label, state: 'running' }
  const failed = items.find((i) => i.state === 'failed')
  if (failed) return { label: failed.label, state: 'failed' }
  const last = items[items.length - 1]
  if (last) return { label: last.label, state: last.state }
  return { label: idleText, state: 'pending' }
}

export function buildProcessSummary(input: ProcessInput, idleText = '空闲'): ProcessSummary {
  const items = buildProcessItems(input)
  const completed = items.filter((i) => i.state === 'completed').length
  const running = items.filter((i) => i.state === 'running').length
  const failed = items.filter((i) => i.state === 'failed').length
  const { label, state } = capsuleLabelOf(items, idleText)
  return { items, completed, total: items.length, running, failed, capsuleLabel: label, capsuleState: state }
}

export const PROCESS_STATE_LABEL: Record<ProcessState, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  pending: '待执行',
}

/** workflow 行的副标题状态文案（复用任务中心口径，不另造枚举） */
export function workflowStatusLabel(status: string | undefined): string {
  return formatTaskStatusZh(status, { fallback: '待处理' })
}

/** 状态面板可自动跳转的「活动」类 tab（不含智能体身份卡） */
export type SummaryActivityTab = 'process' | 'artifacts' | 'platform'

/**
 * 可见 tab：智能体/员工始终在；进程 / 产物 / 平台仅在当前会话有内容时出现。
 * 避免切到空会话仍挂着空「平台」「产物」造成错乱感。
 */
export function buildVisibleSummaryPanelTabs(input: {
  isEmployeeSession?: boolean
  processCount: number
  artifactCount: number
  platformCount: number
  showTask?: boolean
  showDebug?: boolean
  withCount?: (n: number, label: string) => string
}): Array<{ id: string; label: string }> {
  const withCount = input.withCount || ((n, label) => (n > 0 ? `${label} ${n}` : label))
  const list: Array<{ id: string; label: string }> = [
    { id: 'agent', label: input.isEmployeeSession ? '员工' : '智能体' },
  ]
  if (input.processCount > 0) {
    list.push({ id: 'process', label: withCount(input.processCount, '进程') })
  }
  if (input.artifactCount > 0) {
    list.push({ id: 'artifacts', label: withCount(input.artifactCount, '产物') })
  }
  if (input.platformCount > 0) {
    list.push({ id: 'platform', label: withCount(input.platformCount, '平台') })
  }
  if (input.isEmployeeSession && input.showTask) {
    list.push({ id: 'task', label: '任务' })
  }
  if (input.showDebug) {
    list.push({ id: 'debug', label: '调试' })
  }
  return list
}

/** 当前 tab 若不在可见列表（切会话清空 / 观测关闭等），回落到智能体。 */
export function resolveEffectiveSummaryPanelTab(
  panelTab: string,
  visibleTabIds: ReadonlySet<string> | readonly string[],
  opts?: { obsEnabled?: boolean; isEmployeeSession?: boolean },
): string {
  const visible = visibleTabIds instanceof Set ? visibleTabIds : new Set(visibleTabIds)
  if (panelTab === 'debug' && !opts?.obsEnabled) return 'agent'
  if (panelTab === 'employee') return 'agent'
  if (panelTab === 'task' && !opts?.isEmployeeSession) return 'agent'
  if (!visible.has(panelTab)) return 'agent'
  return panelTab
}

export type SummaryActivityPrev = {
  platformFocus: string
  artifactFocus: string
  processRunning: number
}

/**
 * 探测本轮应跳转的活动 tab：平台 / 产物 / 进程，谁是新信号就跟谁。
 * 空 focus 会写入 nextPrev（清掉旧 id），避免跨会话同 id 无法再跳转。
 * 同帧多信号时按「最新优先」：进程 > 产物 > 平台。
 */
export function detectSummaryActivityJump(input: {
  prev: SummaryActivityPrev
  platformFocusId: string
  artifactFocusId: string
  processRunning: number
}): { tab: SummaryActivityTab | null; nextPrev: SummaryActivityPrev } {
  const platformFocus = String(input.platformFocusId || '').trim()
  const artifactFocus = String(input.artifactFocusId || '').trim()
  const processRunning = Math.max(0, Number(input.processRunning) || 0)

  const nextPrev: SummaryActivityPrev = {
    platformFocus,
    artifactFocus,
    processRunning,
  }

  type Cand = { tab: SummaryActivityTab; rank: number }
  const cands: Cand[] = []

  if (platformFocus && platformFocus !== input.prev.platformFocus) {
    cands.push({ tab: 'platform', rank: 1 })
  }
  if (artifactFocus && artifactFocus !== input.prev.artifactFocus) {
    cands.push({ tab: 'artifacts', rank: 2 })
  }
  if (processRunning > 0 && input.prev.processRunning === 0) {
    cands.push({ tab: 'process', rank: 3 })
  }

  if (!cands.length) return { tab: null, nextPrev }
  cands.sort((a, b) => b.rank - a.rank)
  return { tab: cands[0].tab, nextPrev }
}
