import { describe, expect, it } from 'vitest'
import { buildConversationTurnRenderUnits } from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import { inspectConversationTurnFoldHealth } from '../src/zcode-ui/v4/conversationTurnFoldHealth.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

function header(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'turnHeader',
    state: 'running',
    startedAt: rowId,
  } as ConversationRow
}

function user(rowId: number, text: string): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'userInput',
    origin: 'realUser',
    text,
    createdAt: rowId,
  } as ConversationRow
}

function text(rowId: number, body: string, state: 'streaming' | 'complete' = 'complete'): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'assistantText',
    state,
    text: body,
    createdAt: rowId,
  } as ConversationRow
}

function tool(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'toolCall',
    toolCallId: `tc-${rowId}`,
    toolName: 'bash',
    status: 'completed',
  } as ConversationRow
}

describe('inspectConversationTurnFoldHealth', () => {
  it('healthy live turn: only segment-final text outside history', () => {
    const rows: ConversationRow[] = [
      header(1),
      user(2, '你好'),
      tool(3),
      text(4, '中间话', 'complete'),
      tool(5),
      text(6, '段末', 'complete'),
      tool(7),
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: true,
      sessionPhase: 'running',
    })
    const report = inspectConversationTurnFoldHealth(units)
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
  })

  it('flags multi visible assistantText if someone bypasses fold builder', () => {
    const rows: ConversationRow[] = [
      header(1),
      user(2, '你好'),
      text(3, '第一句', 'complete'),
      text(4, '第二句', 'complete'),
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: true,
      sessionPhase: 'running',
    })
    // 正常 builder 只会露出段末；这里人为破坏 flowItems 模拟回归。
    const broken = units.map((unit) => {
      const segment = unit.workSegments?.[0]
      if (!segment) return unit
      return {
        ...unit,
        workSegments: [
          {
            ...segment,
            flowItems: [
              { kind: 'userInput' as const, row: unit.visibleUserInputs[0]! },
              { kind: 'assistantText' as const, row: text(3, '第一句') as never, latest: false },
              { kind: 'assistantText' as const, row: text(4, '第二句') as never, latest: true },
            ],
          },
        ],
      }
    })
    const report = inspectConversationTurnFoldHealth(broken)
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'multi_visible_assistant_text')).toBe(true)
  })
})
