import { describe, expect, it } from 'vitest'
import { buildConversationTurnRenderUnits } from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

function turnRows(headerState: 'running' | 'completedSuccess'): ConversationRow[] {
  return [
    {
      rowId: 1,
      turnId: 't1',
      kind: 'turnHeader',
      origin: 'userInput',
      state: headerState,
      startedAt: 1_000,
      ...(headerState === 'running' ? {} : { endedAt: 2_000 }),
      createdAt: 1_000,
      createdAtSeq: 1,
    },
    {
      rowId: 2,
      turnId: 't1',
      kind: 'userInput',
      text: 'hi',
      origin: 'realUser',
      createdAt: 1_001,
      createdAtSeq: 2,
      actions: { canEdit: false },
    },
    {
      rowId: 3,
      turnId: 't1',
      kind: 'assistantText',
      state: 'complete',
      text: 'ok',
      createdAt: 1_002,
      createdAtSeq: 3,
    },
  ]
}

describe('buildConversationTurnRenderUnits sessionBusy', () => {
  it('forces last turn running when sessionBusy even if header completed', () => {
    const units = buildConversationTurnRenderUnits(turnRows('completedSuccess'), {
      sessionBusy: true,
    })
    expect(units).toHaveLength(1)
    expect(units[0].isRunning).toBe(true)
    expect(units[0].workStatus?.state).toBe('running')
  })

  it('keeps completed when not busy', () => {
    const units = buildConversationTurnRenderUnits(turnRows('completedSuccess'), {
      sessionBusy: false,
    })
    expect(units[0].isRunning).toBe(false)
    expect(units[0].workStatus?.state).toBe('completed')
  })

  it('suppresses stale running header when sessionBusy is false (stop button off)', () => {
    const units = buildConversationTurnRenderUnits(turnRows('running'), {
      sessionBusy: false,
      sessionPhase: 'completedSuccess',
    })
    expect(units[0].isRunning).toBe(false)
    expect(units[0].workStatus?.state).toBe('completed')
  })

  it('does not spin from sessionPhase alone when sessionBusy is false', () => {
    const units = buildConversationTurnRenderUnits(turnRows('completedSuccess'), {
      sessionBusy: false,
      sessionPhase: 'running',
    })
    expect(units[0].isRunning).toBe(false)
  })

  it('keeps live duration ticking when sessionBusy reopens a sealed header', () => {
    const units = buildConversationTurnRenderUnits(turnRows('completedSuccess'), {
      sessionBusy: true,
      nowMs: 6_000,
    })
    expect(units[0].workStatus).toEqual({ state: 'running', durationMs: 5_000 })
    expect(units[0].workSegments?.[0]?.workStatus).toEqual({
      state: 'running',
      durationMs: 5_000,
    })
  })

  it('anchors running duration to userInput when turnHeader is still missing', () => {
    const rows: ConversationRow[] = [
      {
        rowId: 2,
        turnId: 't2',
        kind: 'userInput',
        text: '搞定了吗',
        origin: 'realUser',
        createdAt: 10_000,
        createdAtSeq: 1,
        actions: { canEdit: false },
      },
    ]
    const units = buildConversationTurnRenderUnits(rows, {
      sessionBusy: true,
      nowMs: 13_500,
    })
    expect(units[0].isRunning).toBe(true)
    expect(units[0].workStatus).toEqual({ state: 'running', durationMs: 3_500 })
    expect(units[0].workSegments?.[0]?.workStatus).toEqual({
      state: 'running',
      durationMs: 3_500,
    })
  })
})
