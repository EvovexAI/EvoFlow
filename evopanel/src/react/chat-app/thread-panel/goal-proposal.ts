/**
 * propose_goal / hosted agent proposal parsing + suppress keys.
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { getPanelSetting } from '../../../lib/panel-settings.js'
import { isGoalProposalToolName } from '../../../lib/chat-normalize.js'
import type { DisplayRow, ThreadGoalProposal } from '../../chat-types.js'

export type GoalProposeActionMode = 'dock' | 'auto_fill' | 'auto_start'

/**
 * 模型调用 ``propose_goal`` 且本轮流式 ``final`` 到达后的行为
 * （localStorage ``evopanel_hosted_propose_action`` / panel setting ``goalProposeAction``）：
 * - dock / manual（默认）：仅显示输入区上方确认条
 * - auto_fill / fill：写入目标面板并打开，不自动开跑
 * - auto_start / start / auto：写入并立即开始
 */
export function getGoalProposeActionMode(): GoalProposeActionMode {
  try {
    const v = String(getPanelSetting('goalProposeAction', 'ask' as never) || '').trim().toLowerCase()
    if (v === 'dock' || v === 'manual') return 'dock'
    if (v === 'auto_fill' || v === 'fill' || v === 'panel_only') return 'auto_fill'
    if (v === 'auto_start' || v === 'start' || v === 'auto') return 'auto_start'
  } catch {
    /* ignore */
  }
  return 'dock'
}

export function goalProposalSuppressKey(p: ThreadGoalProposal | null | undefined): string {
  if (!p) return ''
  const id = String(p.toolCallId || '').trim()
  if (id) return `id:${id}`
  const g = String(p.goal || '').trim().slice(0, 200)
  return `goal:${g}`
}

export function readToolInputRecord(tool: unknown): Record<string, unknown> | null {
  const t = (tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : null) || null
  if (!t) return null
  const raw = t.input ?? t.args ?? t.arguments ?? t.kwargs
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw)
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

/** 从单条工具解析 propose_goal 入参（兼容 propose_hosted_agent） */
export function parseGoalProposalFromTool(tool: unknown): ThreadGoalProposal | null {
  const t = (tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : null) || null
  if (!t) return null
  const name = String(t.name || t.tool || t.tool_name || '').trim().toLowerCase()
  if (!isGoalProposalToolName(name)) return null
  const input = readToolInputRecord(tool)
  if (!input) return null
  const goal = String(input.goal ?? input.task ?? input.prompt ?? '').trim()
  if (!goal) return null
  const toolCallId = String(t.id || t.tool_call_id || '').trim() || undefined
  let feishuPushOnComplete: boolean | undefined
  if (input.feishu_push_on_complete !== undefined && input.feishu_push_on_complete !== null) {
    feishuPushOnComplete = Boolean(input.feishu_push_on_complete)
  } else if (input.feishuPushOnComplete !== undefined && input.feishuPushOnComplete !== null) {
    feishuPushOnComplete = Boolean(input.feishuPushOnComplete)
  }
  const pushChannelRaw = input.push_channel ?? input.pushChannel
  const pushTargetIdRaw = input.push_target_id ?? input.pushTargetId
  const pushChannel =
    pushChannelRaw !== undefined && pushChannelRaw !== null ? String(pushChannelRaw).trim() : undefined
  const pushTargetId =
    pushTargetIdRaw !== undefined && pushTargetIdRaw !== null ? String(pushTargetIdRaw).trim() : undefined
  const stepDelayMsRaw = input.step_delay_ms ?? input.stepDelayMs
  const stepDelayMs =
    stepDelayMsRaw !== undefined && stepDelayMsRaw !== null
      ? Math.max(200, Math.min(120_000, Math.round(Number(stepDelayMsRaw))))
      : undefined
  const retryRaw = input.retry_limit ?? input.retryLimit
  const retryLimit =
    retryRaw !== undefined && retryRaw !== null ? Math.max(0, Math.min(20, Math.round(Number(retryRaw)))) : undefined
  const useEvolutionSkill =
    input.use_evolution_skill !== undefined
      ? Boolean(input.use_evolution_skill)
      : input.useEvolutionSkill !== undefined
        ? Boolean(input.useEvolutionSkill)
        : undefined
  return {
    toolCallId,
    goal,
    ...(feishuPushOnComplete !== undefined ? { feishuPushOnComplete } : {}),
    ...(pushChannel ? { pushChannel } : {}),
    ...(pushTargetId ? { pushTargetId } : {}),
    ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
    ...(retryLimit !== undefined ? { retryLimit } : {}),
    ...(useEvolutionSkill !== undefined ? { useEvolutionSkill } : {}),
  }
}

export function extractGoalProposalFromTools(tools: unknown[]): ThreadGoalProposal | null {
  if (!Array.isArray(tools) || !tools.length) return null
  for (let i = tools.length - 1; i >= 0; i--) {
    const hit = parseGoalProposalFromTool(tools[i])
    if (hit) return hit
  }
  return null
}

export function extractLatestGoalProposalFromRows(rows: DisplayRow[]): ThreadGoalProposal | null {
  const hasRowContent = (row: DisplayRow | undefined): boolean => {
    if (!row) return false
    if (String(row.text || '').trim()) return true
    if ((row.tools || []).length) return true
    if ((row.images || []).length) return true
    if ((row.videos || []).length) return true
    if ((row.audios || []).length) return true
    if ((row.files || []).length) return true
    return false
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!hasRowContent(row)) continue
    if (row.role === 'user') return null
    const tools = Array.isArray(row?.tools) ? row.tools : []
    const hit = extractGoalProposalFromTools(tools)
    if (hit) return hit
  }
  return null
}
