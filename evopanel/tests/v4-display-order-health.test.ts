import { describe, expect, it } from 'vitest'
import {
  inspectConversationDisplayOrder,
  repairConversationRowsOrder,
  summarizeDisplayOrderReport,
} from '../src/zcode-ui/v4/conversationDisplayOrderHealth.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

function user(
  rowId: number,
  text: string,
  turnId = 'turn-new',
  createdAt = rowId * 1000,
): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'userInput',
    origin: 'realUser',
    text,
    createdAt,
    createdAtSeq: 0,
  } as ConversationRow
}

function text(
  rowId: number,
  body: string,
  turnId = 'turn-old',
  createdAt = rowId * 1000,
): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'assistantText',
    state: 'complete',
    text: body,
    createdAt,
    createdAtSeq: 0,
  } as ConversationRow
}

function tool(rowId: number, turnId = 'turn-new', createdAt = rowId * 1000): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'toolCall',
    toolCallId: `tc-${rowId}`,
    toolName: 'bash',
    status: 'completed',
    createdAt,
    createdAtSeq: 0,
  } as ConversationRow
}

describe('inspectConversationDisplayOrder', () => {
  it('ok when latest user is at the bottom', () => {
    const rows = [text(1, '上轮结语'), user(2, '新问题')]
    const report = inspectConversationDisplayOrder(rows, {
      expectedUserText: '新问题',
      turnLive: true,
    })
    expect(report.ok).toBe(true)
    expect(report.latestUser?.indexFromEnd).toBe(0)
    expect(summarizeDisplayOrderReport(report)).toContain('显示顺序正常')
  })

  it('flags expected user missing from window', () => {
    const rows = [text(1, '上轮结语'), tool(2, 'turn-old')]
    const report = inspectConversationDisplayOrder(rows, {
      expectedUserText: '新问题',
      turnLive: true,
    })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'expected_user_missing')).toBe(true)
  })

  it('flags buried latest user under a long tool tail', () => {
    const rows: ConversationRow[] = [user(1, '新问题')]
    for (let i = 0; i < 30; i += 1) rows.push(tool(2 + i))
    const report = inspectConversationDisplayOrder(rows, {
      turnLive: true,
      buryWarnRows: 25,
    })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'latest_user_buried')).toBe(true)
    expect(report.latestUser?.indexFromEnd).toBe(30)
  })

  it('flags stale previous-turn assistantText at tail', () => {
    const rows = [
      user(1, '新问题', 'turn-new'),
      text(2, '上轮结语还在尾巴', 'turn-old'),
    ]
    const report = inspectConversationDisplayOrder(rows, { turnLive: true })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'stale_prev_turn_tail')).toBe(true)
  })

  it('flags rowId / createdAt regression in history window', () => {
    const rows = [
      user(10, '后发的', 't2', 10_000),
      text(5, '却插在前面的旧结语', 't1', 5_000),
    ]
    const report = inspectConversationDisplayOrder(rows)
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'row_id_regression')).toBe(true)
    expect(report.repairedRows?.map((r) => r.rowId)).toEqual([5, 10])
  })

  it('flags user bubbles going backwards in time', () => {
    const rows = [
      user(2, '后来的问题', 't2', 2000),
      user(1, '更早的问题却排后面', 't1', 1000),
    ]
    const report = inspectConversationDisplayOrder(rows)
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === 'user_time_regression')).toBe(true)
  })
})

describe('repairConversationRowsOrder', () => {
  it('reorders by rowId for history mis-merge', () => {
    const rows = [text(30, '新'), text(10, '旧'), user(20, '中')]
    const { rows: next, changed } = repairConversationRowsOrder(rows)
    expect(changed).toBe(true)
    expect(next.map((r) => r.rowId)).toEqual([10, 20, 30])
  })

  it('keeps reference when already ordered', () => {
    const rows = [text(1, 'a'), user(2, 'b'), tool(3)]
    const { rows: next, changed } = repairConversationRowsOrder(rows)
    expect(changed).toBe(false)
    expect(next).toBe(rows)
  })
})
