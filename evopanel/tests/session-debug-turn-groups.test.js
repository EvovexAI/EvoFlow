import { describe, expect, it } from 'vitest'
import {
  buildRunIdToChatSeq,
  fmtSessionDebugClock,
  groupCallsByTurn,
} from '../src/react/lib/session-debug-turn-groups.ts'

function call(partial) {
  return {
    id: partial.id || 'c1',
    time: partial.time || '2026-01-01 08:00:00',
    relativeTime: partial.relativeTime || '刚刚',
    occurredAt: partial.occurredAt,
    runId: partial.runId || '',
    status: 'success',
    replyKind: 'text',
    model: 'm',
    latency: '1ms',
    promptTokens: 1,
    completionTokens: 1,
    tokens: 2,
    ...partial,
  }
}

describe('fmtSessionDebugClock', () => {
  it('formats ISO to HH:mm:ss on same calendar day', () => {
    const now = new Date()
    const iso = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      14,
      35,
      21,
    ).toISOString()
    expect(fmtSessionDebugClock(iso)).toBe('14:35:21')
  })

  it('includes month-day when not today', () => {
    expect(fmtSessionDebugClock('2020-01-02T03:04:05')).toMatch(/01-02 03:04:05/)
  })
})

describe('buildRunIdToChatSeq', () => {
  it('prefers user message seq over later assistant seq in same run', () => {
    const map = buildRunIdToChatSeq([
      { seq: 10, role: 'user', run_id: 'run-a' },
      { seq: 11, role: 'assistant', run_id: 'run-a' },
      { seq: 12, role: 'user', runId: 'run-b' },
    ])
    expect(map.get('run-a')).toBe(10)
    expect(map.get('run-b')).toBe(12)
  })

  it('falls back to min seq when user row missing', () => {
    const map = buildRunIdToChatSeq([
      { seq: 21, role: 'assistant', run_id: 'run-x' },
      { seq: 20, role: 'assistant', run_id: 'run-x' },
    ])
    expect(map.get('run-x')).toBe(20)
  })
})

describe('groupCallsByTurn', () => {
  it('titles turns with chat seq and absolute clock', () => {
    const seqMap = new Map([
      ['run-old', 3],
      ['run-new', 9],
    ])
    const groups = groupCallsByTurn(
      [
        call({
          id: '1',
          runId: 'run-old',
          occurredAt: '2026-01-01T01:00:00Z',
          time: 'x',
        }),
        call({
          id: '2',
          runId: 'run-new',
          occurredAt: '2026-01-01T02:00:00Z',
          time: 'y',
        }),
        call({
          id: '3',
          runId: 'run-new',
          occurredAt: '2026-01-01T02:01:00Z',
          time: 'z',
          modelCallSeq: 2,
        }),
      ],
      seqMap,
    )
    expect(groups.map((g) => g.title)).toEqual(['轮次 #9', '轮次 #3'])
    expect(groups[0].chatSeq).toBe(9)
    expect(groups[0].calls).toHaveLength(2)
    expect(groups[0].timeLabel).not.toBe('—')
    expect(groups[0].timeLabel).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('falls back to local index without transcript map', () => {
    const groups = groupCallsByTurn([
      call({ id: '1', runId: 'a', occurredAt: '2026-01-01T01:00:00Z' }),
      call({ id: '2', runId: 'b', occurredAt: '2026-01-01T02:00:00Z' }),
    ])
    expect(groups.map((g) => g.title)).toEqual(['轮次 2', '轮次 1'])
  })
})
