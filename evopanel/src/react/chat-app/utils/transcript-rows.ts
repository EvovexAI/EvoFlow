/**
 * DisplayRow transcript helpers (assistant replace / approval collapse / prompt enhance).
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import { flattenStreamDisplayText } from '../../../lib/chat-normalize.js'
import { isHiddenToolApprovalUserMessage } from '../../../lib/tool-approval.js'
import { shouldMergeFinalIntoPriorAssistant } from '../../lib/collapse-same-turn-assistants.js'
import { mergeAssistantRowWithStreamRow } from '../../lib/merge-assistant-stream-row.js'
import { mergeToolsForPlanDetection } from '../../../lib/plan-pipeline.js'
import { assistantPlainForTurnStrip } from '../../lib/turn-text-isolation.js'
import type { DisplayRow } from '../../chat-types.js'

export function comparableAssistantText(row: DisplayRow | undefined): string {
  if (!row || row.role !== 'assistant') return ''
  return String(
    assistantPlainForTurnStrip(row) ||
      flattenStreamDisplayText(row.segments || [], row.text || '') ||
      '',
  ).trim()
}

export function shouldReplaceFinalAssistantRow(prev: DisplayRow, next: DisplayRow): boolean {
  const prevComparable = comparableAssistantText(prev)
  const nextComparable = comparableAssistantText(next)
  if (!nextComparable || !prevComparable) return false
  if (nextComparable.startsWith(prevComparable)) return true
  const pn = prevComparable.replace(/\s+/g, ' ')
  const nn = nextComparable.replace(/\s+/g, ' ')
  return nn.includes(pn)
}

/** 真实用户轮（跳过工具授权 replay 隐藏 HumanMessage）之后的首条 assistant 下标 */
export function findFirstAssistantAfterRealUser(rows: DisplayRow[]): number {
  let lastRealUser = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'user') continue
    if (isHiddenToolApprovalUserMessage(String(row.text || ''))) continue
    lastRealUser = i
    break
  }
  if (lastRealUser < 0) return -1
  for (let i = lastRealUser + 1; i < rows.length; i++) {
    if (rows[i]?.role === 'assistant') return i
  }
  return -1
}

/**
 * 工具审批暂停会留下 incompleteStream 气泡；批准后 client_stream_replay 又开新 run。
 * final 时把同真实 user 轮内所有 assistant 片段折成一条，避免多截气泡。
 */
export function collapseToolApprovalContinuationRows(
  base: DisplayRow[],
  rowForCommit: DisplayRow,
  opts: { keepIncomplete: boolean; durationStr?: string; tokenStr?: string; sealRunId?: string },
): DisplayRow[] | null {
  const firstAssIdx = findFirstAssistantAfterRealUser(base)
  if (firstAssIdx < 0) return null
  const assistants: DisplayRow[] = []
  for (let i = firstAssIdx; i < base.length; i++) {
    if (base[i]?.role === 'assistant') assistants.push(base[i])
  }
  if (!assistants.length) return null
  const hasIncomplete = assistants.some((a) => a.incompleteStream === true)
  const midPartial =
    assistants.length >= 1 &&
    shouldMergeFinalIntoPriorAssistant(assistants[assistants.length - 1], rowForCommit, opts.sealRunId)
  if (!hasIncomplete && !midPartial && assistants.length <= 1) return null

  let merged: DisplayRow = { ...assistants[0], incompleteStream: true }
  for (let i = 1; i < assistants.length; i++) {
    merged = mergeAssistantRowWithStreamRow(merged, assistants[i])
    merged = {
      ...merged,
      incompleteStream: true,
      tools: mergeToolsForPlanDetection(merged.tools || [], assistants[i].tools || []),
    }
  }
  merged = mergeAssistantRowWithStreamRow(merged, rowForCommit)
  merged = {
    ...merged,
    tools: mergeToolsForPlanDetection(merged.tools || [], rowForCommit.tools || []),
  }
  if (opts.keepIncomplete) {
    merged = {
      ...merged,
      incompleteStream: true,
      durationStr: undefined,
      tokenStr: undefined,
    }
  } else {
    const { incompleteStream: _drop, ...rest } = merged as DisplayRow & { incompleteStream?: boolean }
    merged = {
      ...rest,
      ...(opts.durationStr ? { durationStr: opts.durationStr } : {}),
      ...(opts.tokenStr ? { tokenStr: opts.tokenStr } : {}),
    }
  }
  if (opts.sealRunId) merged = { ...merged, runId: opts.sealRunId }
  else if (assistants[0]?.runId) merged = { ...merged, runId: assistants[0].runId }

  const out: DisplayRow[] = base.slice(0, firstAssIdx)
  for (let i = firstAssIdx; i < base.length; i++) {
    const row = base[i]
    if (row?.role === 'assistant') continue
    if (row?.role === 'user' && isHiddenToolApprovalUserMessage(String(row.text || ''))) continue
    out.push(row)
  }
  out.push(merged)
  return out
}

/** 最近几轮 user/assistant 纯文本，供魔法棒结合上一轮回复优化草稿 */
export function recentTranscriptForPromptEnhance(
  rows: DisplayRow[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const row of rows) {
    if (row.role === 'user') {
      const content = String(row.text || '').trim()
      if (content) out.push({ role: 'user', content })
    } else if (row.role === 'assistant') {
      const content = assistantPlainForTurnStrip(row).trim()
      if (content) out.push({ role: 'assistant', content })
    }
  }
  return out.slice(-6)
}

export type SkillPickerRow = {
  name: string
  label: string
  description: string
  icon: string
  enabled?: boolean
}
