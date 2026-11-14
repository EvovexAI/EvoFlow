import { describe, expect, it } from 'vitest'
import {
  PROJECTION_WINDOW_SOFT_CAP,
  capProjectionWindow,
  countRealUserQueries,
} from '../src/zcode-ui/v4/projectionWindowCap.ts'
import type { ConversationRow } from '../src/zcode-shared/zcode-protocol-v4/index.ts'

function row(
  rowId: number,
  kind: ConversationRow['kind'] = 'assistantMessage',
  origin?: 'realUser',
): ConversationRow {
  return {
    rowId,
    turnId: `t-${Math.floor(rowId / 10)}`,
    kind,
    ...(kind === 'userInput' ? { origin: origin ?? 'realUser', text: `q${rowId}` } : {}),
  } as ConversationRow
}

describe('capProjectionWindow', () => {
  it('returns same reference when under soft cap', () => {
    const rows = [row(1), row(2), row(3)]
    expect(capProjectionWindow(rows, 10)).toBe(rows)
  })

  it('keeps tail and prefers turn boundary', () => {
    const rows: ConversationRow[] = []
    for (let i = 1; i <= 500; i += 1) {
      if (i % 50 === 1) rows.push(row(i, 'turnHeader'))
      else if (i % 50 === 2) rows.push(row(i, 'userInput', 'realUser'))
      else rows.push(row(i, 'toolCall'))
    }
    const capped = capProjectionWindow(rows, 120, 'tail')
    expect(capped.length).toBeLessThanOrEqual(160)
    expect(capped.length).toBeGreaterThanOrEqual(80)
    expect(capped[capped.length - 1]?.rowId).toBe(500)
    expect(
      capped[0]?.kind === 'turnHeader' ||
        (capped[0]?.kind === 'userInput' && capped[0]?.origin === 'realUser'),
    ).toBe(true)
  })

  it('keeps head when prefer=head (scroll-up)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i + 1))
    const capped = capProjectionWindow(rows, 100, 'head')
    expect(capped[0]?.rowId).toBe(1)
    expect(capped.length).toBeLessThanOrEqual(140)
  })
})

describe('countRealUserQueries', () => {
  it('counts realUser inputs only', () => {
    const rows = [
      row(1, 'userInput', 'realUser'),
      row(2, 'assistantMessage'),
      row(3, 'userInput', 'realUser'),
    ]
    expect(countRealUserQueries(rows)).toBe(2)
    expect(PROJECTION_WINDOW_SOFT_CAP).toBeGreaterThan(100)
  })
})
