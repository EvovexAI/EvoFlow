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

describe('V4 turn fold: ZCode-style one visible closing text per segment', () => {
  it('运行中：只把当前流式/段末正文留在折叠外，更早 complete 正文进 history', () => {
    const orderedRows: ConversationRow[] = [
      toolRow(1, 't1'),
      textRow(2, '先说一句', 'complete'),
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
    // 中间 complete 正文折进 history，避免「已工作」外摊多段答复+usage
    expect(segment!.assistantHistoryRows.map((r) => r.rowId)).toEqual([1, 2, 3])
    const visible = segment!.flowItems.filter((item) => item.kind === 'assistantText')
    expect(visible).toHaveLength(1)
    expect(visible[0]?.kind === 'assistantText' && visible[0].row.text).toBe('再说一句')
  })

  it('运行中且段末已是 complete、后面还有工具：段末正文可见，更早正文仍在 history', () => {
    const orderedRows: ConversationRow[] = [
      toolRow(1, 't1'),
      textRow(2, '中间话', 'complete'),
      toolRow(3, 't2'),
      textRow(4, '最新完整句', 'complete'),
      toolRow(5, 't3'),
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
    expect(segment!.assistantHistoryRows.map((r) => r.rowId)).toEqual([1, 2, 3])
    const visible = segment!.flowItems.find((item) => item.kind === 'assistantText')
    expect(visible?.kind === 'assistantText' && visible.row.text).toBe('最新完整句')
    // 段末正文之后的工具跟在折叠外（跟随条），不再被当成又一段「已工作」
    expect(segment!.assistantFollowingRows.map((r) => r.rowId)).toEqual([5])
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

  it('运行中优先跟流式正文（即使后面已有 complete），避免先流出的字闪没', () => {
    const orderedRows: ConversationRow[] = [
      textRow(1, '正在流', 'streaming'),
      toolRow(2, 't1'),
      textRow(3, '后到的 complete', 'complete'),
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
    const visible = segment!.flowItems.filter((item) => item.kind === 'assistantText')
    expect(visible).toHaveLength(1)
    expect(visible[0]?.kind === 'assistantText' && visible[0].row.text).toBe('正在流')
  })
})
