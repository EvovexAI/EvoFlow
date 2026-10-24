import { describe, expect, it } from 'vitest'
import { buildConversationTurnWorkSegments } from '../src/zcode-ui/v4/conversationTurnWorkSegments.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

function textRow(rowId: number, text: string, state: 'streaming' | 'complete' = 'streaming'): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'assistantText',
    state,
    text,
    createdAt: rowId,
    createdAtSeq: rowId,
  }
}

function toolRow(rowId: number, toolCallId: string): ConversationRow {
  return {
    rowId,
    turnId: 'turn-1',
    kind: 'toolCall',
    toolCallId,
    toolName: 'bash',
    status: 'running',
    inputText: '{}',
    createdAt: rowId,
    createdAtSeq: rowId,
    startedAt: rowId,
  }
}

describe('V4 running turn: assistantText interleaves outside tool history', () => {
  it('运行中：正文不进 history，作为独立 assistantText flow 项夹在工具之间', () => {
    const orderedRows: ConversationRow[] = [
      toolRow(1, 't1'),
      textRow(2, '先说一句'),
      toolRow(3, 't2'),
      textRow(4, '再说一句', 'streaming'),
    ]
    const [segment] = buildConversationTurnWorkSegments({
      key: 'turn-1',
      orderedRows,
      assistantTailRows: [],
      isRunning: true,
      isLastTurn: true,
      isInterrupted: false,
      forceOpenHistory: false,
      timelineOnly: false,
    })
    expect(segment).toBeTruthy()
    expect(segment!.assistantHistoryRows.map((r) => r.rowId)).toEqual([1, 3])
    expect(segment!.flowItems.map((item) => item.kind)).toEqual([
      'assistantHistory',
      'assistantText',
      'assistantHistory',
      'assistantText',
    ])
    const texts = segment!.flowItems.filter((item) => item.kind === 'assistantText')
    expect(texts.map((item) => (item.kind === 'assistantText' ? item.row.text : ''))).toEqual([
      '先说一句',
      '再说一句',
    ])
  })

  it('结束后：末段正文仍提升为可见项，中间正文留在 history（既有折叠语义）', () => {
    const orderedRows: ConversationRow[] = [
      toolRow(1, 't1'),
      textRow(2, '中间话', 'complete'),
      toolRow(3, 't2'),
      textRow(4, '最终答复', 'complete'),
    ]
    const [segment] = buildConversationTurnWorkSegments({
      key: 'turn-1',
      orderedRows,
      assistantTailRows: [],
      isRunning: false,
      isLastTurn: true,
      isInterrupted: false,
      forceOpenHistory: false,
      timelineOnly: false,
    })
    expect(segment).toBeTruthy()
    expect(segment!.assistantHistoryRows.map((r) => r.rowId)).toEqual([1, 2, 3])
    const visible = segment!.flowItems.find((item) => item.kind === 'assistantText')
    expect(visible?.kind === 'assistantText' && visible.row.text).toBe('最终答复')
  })
})
