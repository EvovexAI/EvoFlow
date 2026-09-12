import { describe, expect, it } from 'vitest'
import { messagesToDisplayRows } from '../src/lib/chat-normalize.js'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import { buildWorkProcessEvents } from '../src/lib/proactive-work-process.js'
import { messagesToSubtaskModalRows } from '../src/lib/subtask-modal-rows.js'

const raw = [
  {
    role: 'assistant',
    type: 'ai',
    content_json: {
      content: '好的，我来将这个会话思维导图数据添加到知识库。\n\n',
      tool_calls: [
        {
          name: 'platform',
          args: { action: 'knowledge.create', confirm: true },
          id: 'call_691954211e5e4c3a9d3f3647',
          type: 'tool_call',
        },
      ],
    },
    id: 'lc_run--a',
    run_id: 'r1',
    seq: 1719,
  },
  {
    role: 'tool',
    type: 'tool',
    content_json: {
      content: JSON.stringify({
        ok: true,
        hint: '已创建；导入内容用 knowledge.ingest。',
        action: 'knowledge.create',
      }),
    },
    id: 'tool-call_691954211e5e4c3a9d3f3647',
    tool_call_id: 'call_691954211e5e4c3a9d3f3647',
    name: 'platform',
    run_id: 'r1',
    seq: 1720,
  },
  {
    role: 'assistant',
    type: 'ai',
    content_json: {
      content:
        '本轮值班开始。\n\n**1. 状态核查**\n看板显示唯一未结任务。\n\n**结论**：本轮值班结束。',
    },
    id: 'lc_run--b',
    run_id: 'r1',
    seq: 1721,
  },
]

describe('duty wrap-up after knowledge.create', () => {
  it('keeps body text visible in chat bubble slots after tools', () => {
    const rows = messagesToDisplayRows(raw)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const row = rows.find((r) => r.role === 'assistant')
    expect(row).toBeTruthy()
    const flat = [
      String(row.text || ''),
      ...(row.segments || []).filter((s) => s.kind === 'text').map((s) => String(s.text || '')),
    ].join('\n')
    expect(flat).toContain('本轮值班结束')

    const plan = buildAssistantBubbleDisplayPlan({
      row,
      displaySegments: row.segments || [],
      tools: row.tools || [],
      rawText: row.text || '',
      textTrimmed: !!(row.text || '').trim(),
      reasoningSegments: row.reasoningSegments || [],
      reasoningPreview: row.reasoningPreview || '',
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: (row.tools || []).length > 0,
      legacyHasTools: (row.tools || []).length > 0,
      legacyShowBody: true,
      plainBodyRaw: row.text || '',
      plainShowThinkingCursor: false,
      aguiTurn: null,
    })
    const bodySlots = plan.slots.filter(
      (s) =>
        (s.kind === 'plain-body' || s.kind === 'live-tail' || s.kind === 'legacy-body') &&
        String(s.text || '').includes('本轮值班结束'),
    )
    expect(bodySlots.length).toBeGreaterThanOrEqual(1)
  })

  it('emits model reply in work process after tools', () => {
    const rows = messagesToSubtaskModalRows(raw)
    const events = buildWorkProcessEvents(rows)
    const model = events.filter((e) => e.kind === 'model' || e.action === '模型回复')
    expect(model.some((e) => String(e.summary || e.title || '').includes('本轮值班结束'))).toBe(true)
  })
})
