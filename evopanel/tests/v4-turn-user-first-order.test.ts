import { describe, expect, it } from 'vitest'
import {
  buildConversationTurnRenderUnits,
  EMPTY_RUN_NOTICE_TEXT,
  normalizeOrderedRowsUserFirst,
} from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

function turnHeader(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'turnHeader',
    state: 'completedSuccess',
    startedAt: rowId,
    origin: 'userInput',
  } as ConversationRow
}

function userInput(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'userInput',
    origin: 'realUser',
    text,
    createdAt: rowId,
  } as ConversationRow
}

function toolCall(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'toolCall',
    toolCallId: `tc-${rowId}`,
    toolName: 'bash',
    name: 'bash',
    status: 'success',
  } as ConversationRow
}

function assistantText(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'assistantText',
    text,
    state: 'complete',
    createdAt: rowId,
  } as ConversationRow
}

describe('normalizeOrderedRowsUserFirst', () => {
  it('drops stolen work rows with rowId before realUser (not relocate into turn)', () => {
    const turnId = 'run-split'
    const rows: ConversationRow[] = [
      toolCall(10, turnId),
      toolCall(11, turnId),
      userInput(12, turnId, '啥意思？重启号你不验证吗？'),
      assistantText(13, turnId, '验完了'),
    ]
    const next = normalizeOrderedRowsUserFirst(rows)
    expect(next.map((r) => r.kind)).toEqual(['userInput', 'assistantText'])
    expect(next.map((r) => r.rowId)).toEqual([12, 13])
    expect(next[0]?.kind === 'userInput' && next[0].text).toContain('啥意思')
  })

  it('drops stolen tools even when pinned after the user bubble', () => {
    const turnId = 'run-4a35a33d4ff8'
    const rows: ConversationRow[] = [
      userInput(2162, turnId, '我已经重启好了，你试一下'),
      toolCall(2007, turnId),
      toolCall(2008, turnId),
      assistantText(2165, turnId, '正在验证'),
    ]
    const next = normalizeOrderedRowsUserFirst(rows)
    expect(next.map((r) => r.rowId)).toEqual([2162, 2165])
  })

  it('no-ops when user already leads with later tools only', () => {
    const turnId = 'run-ok'
    const rows: ConversationRow[] = [
      userInput(1, turnId, 'hello'),
      toolCall(2, turnId),
    ]
    const next = normalizeOrderedRowsUserFirst(rows)
    expect(next.map((r) => r.rowId)).toEqual([1, 2])
  })
})

describe('buildConversationTurnRenderUnits empty-run strip', () => {
  it('hides empty-run notice when a later turn already has real assistant work', () => {
    const t1 = 'turn-empty-first'
    const t2 = 'turn-continue'
    const rows: ConversationRow[] = [
      turnHeader(1, t1),
      userInput(2, t1, '你好'),
      {
        rowId: 3,
        turnId: t1,
        kind: 'assistantText',
        text: EMPTY_RUN_NOTICE_TEXT,
        state: 'complete',
        createdAt: 3,
        entityId: `empty-run-${t1}`,
      } as ConversationRow,
      turnHeader(4, t2),
      userInput(5, t2, '继续'),
      assistantText(6, t2, '在的，随时说。'),
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: false,
      sessionPhase: 'completedSuccess',
    })
    expect(units).toHaveLength(2)
    const firstTexts = units[0]?.assistantTextRows ?? []
    expect(firstTexts.every((r) => !String(r.entityId || '').startsWith('empty-run-'))).toBe(
      true,
    )
    expect(units[1]?.assistantTextRows?.[0]?.text).toContain('在的')
  })

  it('does not invent empty-run on the client for orphan completed turns', () => {
    const turnId = 'e7da31aa-orphan'
    const rows: ConversationRow[] = [
      turnHeader(1, turnId),
      userInput(2, turnId, '再来，再简单来一次'),
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: false,
      sessionPhase: 'completedSuccess',
    })
    expect(units).toHaveLength(1)
    expect(units[0]?.assistantTextRows ?? []).toHaveLength(0)
  })

  it('hides freshly written empty-run for a few seconds (no flash before late TEXT)', () => {
    const turnId = 'turn-fresh-empty'
    const nowMs = 1_000_000
    const rows: ConversationRow[] = [
      turnHeader(1, turnId),
      userInput(2, turnId, 'hi'),
      {
        rowId: 3,
        turnId,
        kind: 'assistantText',
        text: EMPTY_RUN_NOTICE_TEXT,
        state: 'complete',
        createdAt: nowMs - 500,
        entityId: `empty-run-${turnId}`,
      } as ConversationRow,
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: false,
      sessionPhase: 'completedSuccess',
      nowMs,
    })
    expect(units[0]?.assistantTextRows ?? []).toHaveLength(0)
  })
})

describe('buildConversationTurnRenderUnits tools-before-user', () => {
  it('hides stolen pre-user tools so new turn does not show prior bash', () => {
    // 现场 dump：新用户 2162 + 旧工具 2007… 同 turnId（RESULT 偷挂）
    const turnId = 'run-a244892b'
    const rows: ConversationRow[] = [
      toolCall(100, turnId),
      toolCall(101, turnId),
      toolCall(102, turnId),
      turnHeader(103, turnId),
      userInput(104, turnId, '啥意思？重启号你不验证吗？你刚改那么多东西'),
      assistantText(105, turnId, 'retention 也验完了'),
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: false,
      sessionPhase: 'completedSuccess',
    })
    expect(units).toHaveLength(1)
    const flowKinds = (units[0]?.workSegments?.[0]?.flowItems ?? []).map((item) => item.kind)
    expect(flowKinds[0]).toBe('userInput')
    expect(flowKinds).not.toContain('assistantHistory')
    expect(units[0]?.assistantWorkRows.every((r) => (Number(r.rowId) || 0) >= 104)).toBe(
      true,
    )
    const firstUser = units[0]?.workSegments?.[0]?.flowItems.find((i) => i.kind === 'userInput')
    expect(firstUser?.kind === 'userInput' && firstUser.row.text).toContain('啥意思')
  })
})
