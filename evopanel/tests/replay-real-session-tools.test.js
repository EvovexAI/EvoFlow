import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildHistoryViewFromRaw } from '../src/react/lib/chatHistoryView.ts'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'

/**
 * 用真实会话（agent:main:new-0151eed8，16:44 那轮 12 个工具轮）回放：
 * 历史行 → collapse → display plan，检查各工具轮是否在显示计划中存活。
 * 数据源：GET /chat/sessions/{key}/messages 原始返回。
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const raw = JSON.parse(
  readFileSync(join(__dir, 'fixtures', 'replay-new0151eed8.json'), 'utf8'),
)
const messages = raw.messages || raw.items || []

const view = buildHistoryViewFromRaw(messages)

function collectPlanToolIds(row) {
  const input = {
    row,
    displaySegments: row.segments || [],
    tools: row.tools || [],
    rawText: row.text || '',
    text: row.text || '',
    textTrimmed: !!String(row.text || '').trim(),
    reasoningPreview: row.reasoningPreview || '',
    reasoningSegments: row.reasoningSegments || [],
    isStreaming: false,
    interactiveToolApproval: false,
    suppressPlanExecPromptNoise: false,
    hasToolsInTurnEarly: true,
    systemActivityLabel: '',
    streamThinkingLabel: '',
    legacyHasTools: false,
    legacyShowBody: true,
    plainBodyRaw: '',
    plainShowThinkingCursor: false,
  }
  const plan = buildAssistantBubbleDisplayPlan(input)
  const out = { chunkToolIds: [], standaloneToolIds: [], orphanTools: [], chunkCount: 0, pieces: [] }
  for (const slot of plan.slots) {
    if (slot.kind === 'chunk' && slot.chunk.kind === 'activity') {
      out.chunkCount += 1
      for (const piece of slot.chunk.pieces) {
        out.pieces.push(`${piece.kind}${piece.kind === 'tools' ? `(${piece.ids.join(',')})` : ''}`)
        if (piece.kind === 'tools') out.chunkToolIds.push(...piece.ids)
      }
    }
    if (slot.kind === 'tools-standalone') out.standaloneToolIds.push(...slot.ids)
    if (slot.kind === 'orphan-tools') out.orphanTools.push(...(slot.tools || []).map((t) => t.id || t.tool_call_id))
  }
  return out
}

describe('真实会话回放：多轮工具不应消失', () => {
  it('历史行包含全部 12 个工具', () => {
    const asstRows = view.rows.filter((r) => r.role === 'assistant' && (r.tools?.length || (r.segments || []).some((s) => s.kind === 'tools')))
    expect(asstRows.length, '应有含工具的 assistant 行').toBeGreaterThan(0)
    for (const row of asstRows) {
      const segToolIds = (row.segments || []).filter((s) => s.kind === 'tools').flatMap((s) => s.ids || [])
      const listToolIds = (row.tools || []).map((t) => t.id || t.tool_call_id)
      const plan = collectPlanToolIds(row)
      console.log('row:', JSON.stringify({
        segToolIds: segToolIds.length,
        listToolIds: listToolIds.length,
        planChunkToolIds: plan.chunkToolIds.length,
        planStandalone: plan.standaloneToolIds.length,
        orphan: plan.orphanTools.length,
        chunkCount: plan.chunkCount,
        pieces: plan.pieces,
      }, null, 1))
    }
    // 最后一轮 assistant（最终汇报那条）应包含整轮所有工具
    const last = asstRows[asstRows.length - 1]
    const plan = collectPlanToolIds(last)
    const allIds = [...plan.chunkToolIds, ...plan.standaloneToolIds, ...plan.orphanTools]
    expect(allIds.length, `最终气泡应含整轮工具（实际 ${JSON.stringify(plan)}）`).toBeGreaterThanOrEqual(12)
  })
})
