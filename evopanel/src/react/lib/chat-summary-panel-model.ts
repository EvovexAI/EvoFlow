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
import type { SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'

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
}

/** 终端命令行压到单行、限长，避免长命令撑破面板 */
function compactCommand(raw: string, max = 72): string {
  const oneLine = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

function terminalState(t: TerminalStreamTask): ProcessState {
  const phase = String(t?.phase || '').trim().toLowerCase()
  if (phase === 'running') return 'running'
  if (phase === 'failed') return 'failed'
  // phase === 'success'，但 exitCode 非 0 仍算失败（后端 phase 可能滞后）
  const code = Number(t?.exitCode)
  if (Number.isFinite(code) && code !== 0) return 'failed'
  return 'completed'
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

  for (const t of Object.values(input.terminalStreams || {})) {
    if (!t) continue
    const command = compactCommand(t.command || '')
    items.push({
      id: `terminal:${t.toolCallId}${t.invocationId ? `:${t.invocationId}` : ''}`,
      kind: 'terminal',
      label: command || '终端',
      state: terminalState(t),
      detail: t.exitCode != null && Number(t.exitCode) !== 0 ? `退出码 ${t.exitCode}` : undefined,
      source: t,
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
