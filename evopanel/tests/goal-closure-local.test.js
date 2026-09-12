import { describe, expect, it } from 'vitest'
import {
  insertClosureRowsByTimestamp,
  mergeRowsWithGoalClosureEphemerals,
  resolveClosureInsertIndex,
  resolveGoalClosureTimestamp,
} from '../src/react/lib/goalClosureLocal.ts'

describe('resolveGoalClosureTimestamp', () => {
  it('prefers ended_at in ms', () => {
    expect(resolveGoalClosureTimestamp({ ended_at: 1_700_000_000_000 })).toBe(1_700_000_000_000)
  })

  it('converts ended_at seconds to ms', () => {
    expect(resolveGoalClosureTimestamp({ ended_at: 1_700_000_000 })).toBe(1_700_000_000_000)
  })
})

describe('resolveClosureInsertIndex', () => {
  it('inserts between timestamped rows', () => {
    const rows = [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant', timestamp: 2000 },
      { role: 'user', timestamp: 4000 },
    ]
    expect(resolveClosureInsertIndex(rows, 2500)).toBe(2)
    expect(resolveClosureInsertIndex(rows, 500)).toBe(0)
    expect(resolveClosureInsertIndex(rows, 5000)).toBe(3)
  })

  it('keeps live _stream at tail', () => {
    const rows = [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant', timestamp: 2000 },
      { role: '_stream' },
    ]
    expect(resolveClosureInsertIndex(rows, 2500)).toBe(2)
    expect(resolveClosureInsertIndex(rows, 5000)).toBe(2)
  })

  it('inherits timestamp from prior row when missing', () => {
    const rows = [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant' },
      { role: 'user', timestamp: 3000 },
    ]
    expect(resolveClosureInsertIndex(rows, 1500)).toBe(2)
  })
})

describe('insertClosureRowsByTimestamp', () => {
  it('orders multiple closure rows chronologically', () => {
    const rows = [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant', timestamp: 5000 },
    ]
    const out = insertClosureRowsByTimestamp(rows, [
      { role: 'system', text: 'b', timestamp: 4000 },
      { role: 'system', text: 'a', timestamp: 2000 },
    ])
    expect(out.map((r) => r.timestamp)).toEqual([1000, 2000, 4000, 5000])
  })
})

describe('mergeRowsWithGoalClosureEphemerals', () => {
  it('inserts stored closure by timestamp instead of appending to tail', () => {
    const key = 'evopanel-goal-closure-reports-v1'
    localStorage.setItem(
      key,
      JSON.stringify({
        'sess-1': [{ ts: 2500, outcome: '任务完成', body: '第一轮汇报' }],
      }),
    )
    const rows = [
      { role: 'user', timestamp: 1000 },
      { role: 'assistant', timestamp: 2000 },
      { role: 'user', timestamp: 4000 },
      { role: 'assistant', timestamp: 5000 },
    ]
    const merged = mergeRowsWithGoalClosureEphemerals(rows, 'sess-1')
    expect(merged).toHaveLength(5)
    expect(merged[2]?.role).toBe('system')
    expect(String(merged[2]?.text || '')).toContain('[目标汇报]')
    expect(merged[3]?.timestamp).toBe(4000)
    localStorage.removeItem(key)
  })
})
