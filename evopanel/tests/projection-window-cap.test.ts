import { describe, expect, it } from 'vitest'
import {
  PROJECTION_HEAVY_HORIZON,
  PROJECTION_WINDOW_SOFT_CAP,
  capAndLightenProjectionWindow,
  capProjectionWindow,
  countRealUserQueries,
  ensureLiveTurnInProjectionWindow,
  lightenProjectionRowsForMemory,
  repairPartialTurnsInProjectionWindow,
  selectLiveTurnWithinBudget,
  selectOlderCompleteTurnsWithinBudget,
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

  it('does not leave window starting mid previous turn after soft-cap', () => {
    const rows: ConversationRow[] = []
    // 超长上一轮（模拟电脑控制长跑）
    rows.push(row(1, 'turnHeader'))
    rows.push(row(2, 'userInput', 'realUser'))
    for (let i = 3; i <= 120; i += 1) rows.push(row(i, 'toolCall'))
    // 新开一轮（用户追问）
    rows.push(row(121, 'turnHeader'))
    rows.push(row(122, 'userInput', 'realUser'))
    for (let i = 123; i <= 160; i += 1) rows.push(row(i, 'assistantText'))
    for (const r of rows) {
      if (r.rowId <= 120) (r as { turnId: string }).turnId = 'prev'
      else (r as { turnId: string }).turnId = 'live'
    }
    // 模拟软顶后窗顶落在上一轮 mid-tool（现场 window=56…）
    const midPrev = rows.filter((r) => r.rowId >= 56)
    const pinned = ensureLiveTurnInProjectionWindow(rows, midPrev, 100)
    expect(pinned[0]?.kind).toBe('turnHeader')
    expect(pinned.some((r) => r.rowId === 122)).toBe(true)
    expect(pinned[0]?.rowId).not.toBe(56)
  })

  it('keeps previous turn header+user when live turn alone fills softCap (post-send history eaten)', () => {
    // 现场：发完「我已重启好了」后直播轮工具卡暴涨 ≥ softCap，旧逻辑
    // `liveKept.length >= cap → return liveKept` 把上一问整轮从窗口拿掉。
    const rows: ConversationRow[] = []
    rows.push(row(1, 'turnHeader'))
    rows.push(row(2, 'userInput', 'realUser'))
    for (let i = 3; i <= 20; i += 1) rows.push(row(i, 'toolCall'))
    rows.push(row(21, 'turnHeader'))
    rows.push(row(22, 'userInput', 'realUser'))
    for (let i = 23; i <= 200; i += 1) {
      rows.push({ ...row(i, 'toolCall'), status: 'success' } as ConversationRow)
    }
    rows.push({
      rowId: 201,
      turnId: 'live',
      kind: 'reasoning',
      text: 'still thinking',
      state: 'streaming',
    } as ConversationRow)
    for (const r of rows) {
      if (r.rowId <= 20) (r as { turnId: string }).turnId = 'prev'
      else (r as { turnId: string }).turnId = 'live'
    }

    // prefer:tail 软顶后窗内只剩直播轮尾（上一问已被裁掉）
    const softCap = 80
    const tailOnly = capProjectionWindow(rows, softCap, 'tail')
    expect(tailOnly.some((r) => r.rowId === 2)).toBe(false)

    const pinned = ensureLiveTurnInProjectionWindow(rows, [...tailOnly], softCap)
    expect(pinned.some((r) => r.rowId === 1 && r.kind === 'turnHeader')).toBe(true)
    expect(pinned.some((r) => r.rowId === 2 && r.kind === 'userInput')).toBe(true)
    expect(pinned.some((r) => r.rowId === 22)).toBe(true)
    expect(pinned.some((r) => r.kind === 'reasoning' && r.state === 'streaming')).toBe(
      true,
    )
  })
})

describe('selectLiveTurnWithinBudget', () => {
  it('keeps mid-turn streaming reasoning that head+tail would drop', () => {
    const live: ConversationRow[] = []
    live.push(row(1, 'turnHeader'))
    live.push(row(2, 'userInput', 'realUser'))
    live.push({
      ...row(3, 'reasoning'),
      state: 'streaming',
      text: '正在核实插件',
    } as ConversationRow)
    for (let i = 4; i <= 120; i += 1) {
      live.push({ ...row(i, 'toolCall'), status: 'success' } as ConversationRow)
    }
    for (const r of live) (r as { turnId: string }).turnId = 'live'

    // 模拟 prefer=tail 只留尾部，思考行落在窗外
    const tailOnly = live.slice(-40)
    expect(tailOnly.some((r) => r.kind === 'reasoning')).toBe(false)

    const pinned = ensureLiveTurnInProjectionWindow(live, tailOnly, 50)
    const reasoning = pinned.find((r) => r.kind === 'reasoning')
    expect(reasoning).toBeTruthy()
    expect(reasoning?.state).toBe('streaming')
    expect(String((reasoning as { text?: string }).text || '')).toContain('核实')

    const kept = selectLiveTurnWithinBudget(live, 1, 0, 50)
    expect(kept.some((r) => r.kind === 'reasoning' && r.state === 'streaming')).toBe(
      true,
    )
  })
})

describe('selectOlderCompleteTurnsWithinBudget', () => {
  it('picks complete trailing turns instead of mid-turn row slices', () => {
    const rows: ConversationRow[] = [
      row(1, 'turnHeader'),
      row(2, 'userInput', 'realUser'),
      row(3, 'toolCall'),
      row(4, 'turnHeader'),
      row(5, 'userInput', 'realUser'),
      row(6, 'toolCall'),
      row(7, 'toolCall'),
      row(8, 'turnHeader'),
      row(9, 'userInput', 'realUser'),
    ]
    for (const r of rows) {
      if (r.rowId <= 3) (r as { turnId: string }).turnId = 'a'
      else if (r.rowId <= 7) (r as { turnId: string }).turnId = 'b'
      else (r as { turnId: string }).turnId = 'live'
    }
    const older = selectOlderCompleteTurnsWithinBudget(rows, 8, 4)
    expect(older[0]?.kind).toBe('turnHeader')
    expect(older[0]?.rowId).toBe(4)
    expect(older.every((r) => r.rowId < 8)).toBe(true)
  })
})

describe('repairPartialTurnsInProjectionWindow', () => {
  it('pulls back same-turn tools cut by soft-cap tail (orphan user heal)', () => {
    const turnId = 'e7da31aa-1dc'
    const full: ConversationRow[] = [
      {
        rowId: 600,
        turnId,
        kind: 'toolCall',
        toolCallId: 'tc-600',
        toolName: 'platform',
        status: 'success',
      } as ConversationRow,
      {
        rowId: 601,
        turnId,
        kind: 'toolCall',
        toolCallId: 'tc-601',
        toolName: 'bash',
        status: 'success',
      } as ConversationRow,
      {
        rowId: 620,
        turnId,
        kind: 'turnHeader',
        state: 'completedSuccess',
        origin: 'userInput',
        startedAt: 1,
      } as ConversationRow,
      {
        rowId: 621,
        turnId,
        kind: 'userInput',
        origin: 'realUser',
        text: '再来，再简单来一次',
        createdAt: 2,
      } as ConversationRow,
      {
        rowId: 650,
        turnId: 'other',
        kind: 'userInput',
        origin: 'realUser',
        text: '哈哈哈',
        createdAt: 3,
      } as ConversationRow,
    ]
    // soft-cap 尾窗只剩 header+user，工具落在窗外 → 用户看见 AI 空了
    const capped = full.filter((r) => r.rowId >= 620)
    const repaired = repairPartialTurnsInProjectionWindow(full, capped)
    expect(repaired.some((r) => r.rowId === 600 && r.kind === 'toolCall')).toBe(true)
    expect(repaired.some((r) => r.rowId === 601 && r.kind === 'toolCall')).toBe(true)
    expect(repaired.some((r) => r.kind === 'userInput' && r.turnId === turnId)).toBe(true)
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
