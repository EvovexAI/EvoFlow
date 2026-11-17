import { describe, expect, it } from 'vitest'
import {
  PROJECTION_HEAVY_HORIZON,
  PROJECTION_WINDOW_SOFT_CAP,
  capAndLightenProjectionWindow,
  capProjectionWindow,
  countRealUserQueries,
  ensureLiveTurnInProjectionWindow,
  lightenProjectionRowsForMemory,
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

function heavyTool(rowId: number): ConversationRow {
  return {
    rowId,
    turnId: `t-${Math.floor(rowId / 10)}`,
    kind: 'toolCall',
    toolCallId: `tc-${rowId}`,
    name: 'platform',
    output: {
      text: 'x'.repeat(8_000),
      display: { kind: 'platform', title: `heavy-${rowId}` },
    },
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
    expect(capped[0]?.kind).toBe('turnHeader')
  })

  it('keeps head when prefer=head (scroll-up)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i + 1))
    const capped = capProjectionWindow(rows, 100, 'head')
    expect(capped[0]?.rowId).toBe(1)
    expect(capped.length).toBeLessThanOrEqual(140)
  })

  it('under softCap never evicts history (2026-11-15 回撤焦点窗重建)', () => {
    // 用户距底 118 行是长回合直播的自然形态：ZCode 契约 = store 持有全会话行，
    // 客户端绝不按埋深重建窗口把前面轮次丢掉（「历史记录看不到了」的实锤）。
    const rows: ConversationRow[] = []
    rows.push(row(1, 'turnHeader'))
    rows.push(row(2, 'userInput', 'realUser'))
    for (let i = 3; i <= 120; i += 1) rows.push(row(i, 'toolCall'))
    const capped = capProjectionWindow(rows, 220, 'tail')
    expect(capped).toBe(rows)
    expect(capped[0]?.kind).toBe('turnHeader')
    expect(capped.some((r) => r.kind === 'userInput')).toBe(true)
  })

  it('over softCap trims at turn boundary without rebuilding (tail kept)', () => {
    const rows: ConversationRow[] = []
    rows.push(row(1, 'turnHeader'))
    rows.push(row(2, 'userInput', 'realUser'))
    rows.push({
      rowId: 3,
      turnId: 't-live',
      kind: 'assistantText',
      text: '先流出的一段',
      state: 'complete',
      createdAt: 3,
      createdAtSeq: 3,
    } as ConversationRow)
    for (let i = 4; i <= 200; i += 1) {
      rows.push(row(i, 'toolCall'))
    }
    rows.push({
      rowId: 201,
      turnId: 't-live',
      kind: 'assistantText',
      text: '轮尾最新',
      state: 'streaming',
      createdAt: 201,
      createdAtSeq: 201,
    } as ConversationRow)
    for (const r of rows) {
      ;(r as { turnId: string }).turnId = 't-live'
    }
    const capped = capProjectionWindow(rows, 80, 'tail')
    // 单一超长轮（无近界 turnHeader）→ 硬切，但尾部原样保留，绝不重建焦点窗
    expect(capped[capped.length - 1]?.rowId).toBe(201)
    expect(capped.length).toBeLessThanOrEqual(120)
    expect(capped.length).toBeGreaterThanOrEqual(40)
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

describe('lightenProjectionRowsForMemory', () => {
  it('trims old tool payloads outside heavy horizon; stripDisplay drops display', () => {
    const rows: ConversationRow[] = []
    for (let i = 1; i <= 100; i += 1) {
      rows.push(i <= 40 ? heavyTool(i) : row(i))
    }
    const keepDisplay = lightenProjectionRowsForMemory(rows, 60)
    const earlyKeep = keepDisplay[0] as {
      output?: { text?: string; display?: unknown }
    }
    expect(earlyKeep.output?.text?.includes('[trimmed for memory]')).toBe(true)
    expect(earlyKeep.output?.display).toEqual({ kind: 'platform', title: 'heavy-1' })

    const stripped = lightenProjectionRowsForMemory(rows, 60, { stripDisplay: true })
    const early = stripped[0] as { output?: { text?: string; display?: unknown } }
    const late = stripped[90] as { kind?: string }
    expect(early.output?.text?.includes('[trimmed for memory]')).toBe(true)
    expect(early.output?.display).toBeUndefined()
    expect(late.kind).toBe('assistantMessage')
    expect(stripped).not.toBe(rows)
  })

  it('returns same reference when nothing to lighten', () => {
    const rows = [row(1), row(2), heavyTool(3)]
    expect(lightenProjectionRowsForMemory(rows, 60)).toBe(rows)
  })
})

describe('ensureLiveTurnInProjectionWindow', () => {
  it('re-pins live turn when prefer=head capped it away', () => {
    const rows: ConversationRow[] = []
    for (let i = 1; i <= 200; i += 1) {
      if (i % 50 === 1) rows.push(row(i, 'turnHeader'))
      else if (i % 50 === 2) rows.push(row(i, 'userInput', 'realUser'))
      else rows.push(row(i, 'toolCall'))
    }
    // 新一轮贴在末尾
    rows.push(row(201, 'turnHeader'))
    rows.push(row(202, 'userInput', 'realUser'))
    rows.push({
      rowId: 203,
      turnId: 't-live',
      kind: 'assistantText',
      text: '新轮正文',
      state: 'streaming',
    } as ConversationRow)
    for (const r of rows.slice(-3)) {
      ;(r as { turnId: string }).turnId = 't-live'
    }
    const headCapped = capProjectionWindow(rows, 80, 'head')
    expect(headCapped.some((r) => r.rowId === 203)).toBe(false)
    const pinned = ensureLiveTurnInProjectionWindow(rows, headCapped, 80)
    expect(pinned[pinned.length - 1]?.rowId).toBe(203)
    expect(pinned.some((r) => r.kind === 'userInput' && r.rowId === 202)).toBe(true)
    expect(pinned.length).toBeLessThanOrEqual(80)
  })

  it('no-ops when live turn already in capped window', () => {
    const rows = [row(1, 'turnHeader'), row(2, 'userInput', 'realUser'), row(3)]
    expect(ensureLiveTurnInProjectionWindow(rows, rows, 40)).toBe(rows)
  })
})

describe('capAndLightenProjectionWindow', () => {
  it('caps then lightens under a tight softCap', () => {
    const rows: ConversationRow[] = []
    for (let i = 1; i <= 200; i += 1) {
      rows.push(i % 5 === 0 ? heavyTool(i) : row(i))
    }
    const next = capAndLightenProjectionWindow(rows, {
      softCap: 80,
      prefer: 'tail',
      heavyHorizon: 40,
    })
    expect(next.length).toBeLessThanOrEqual(120)
    expect(next[next.length - 1]?.rowId).toBe(200)
    const oldHeavy = next.find(
      (r) =>
        r.kind === 'toolCall' &&
        typeof (r as { output?: { text?: string } }).output?.text === 'string' &&
        String((r as { output?: { text?: string } }).output?.text).includes(
          '[trimmed for memory]',
        ),
    )
    expect(oldHeavy).toBeTruthy()
    expect(PROJECTION_HEAVY_HORIZON).toBeGreaterThan(20)
  })
})
