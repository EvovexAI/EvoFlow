import { describe, expect, it } from 'vitest'
import {
  PROJECTION_HEAVY_HORIZON,
  PROJECTION_WINDOW_SOFT_CAP,
  capAndLightenProjectionWindow,
  capProjectionWindow,
  countRealUserQueries,
  ensureLiveTurnInProjectionWindow,
  isProjectionWindowBallooned,
  lightenProjectionRowsForMemory,
  liveTurnSpan,
  pinLiveTurnAfterDeltas,
  pinTurnRowsAtTail,
  releaseBalloonProjectionWindow,
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

  it('pins earlier in-flight turn when a later completed user exists (6666 vs 333)', () => {
    // 现场：6666 工具洪峰未收尾时窗内又冒出已完成的 333；旧 liveTurnSpan 只认
    // 最新 realUser → 软顶把 6666 用户气泡挤掉，流式还在回「666 收到」。
    const rows: ConversationRow[] = []
    rows.push({
      rowId: 1,
      turnId: 't-6666',
      kind: 'turnHeader',
      state: 'running',
      origin: 'userInput',
    } as ConversationRow)
    rows.push({
      rowId: 2,
      turnId: 't-6666',
      kind: 'userInput',
      origin: 'realUser',
      text: '6666',
    } as ConversationRow)
    for (let i = 3; i <= 180; i += 1) {
      rows.push({
        ...row(i, 'toolCall'),
        turnId: 't-6666',
        status: i === 180 ? 'running' : 'success',
        toolName: `platform-${i}`,
      } as ConversationRow)
    }
    rows.push({
      rowId: 181,
      turnId: 't-333',
      kind: 'turnHeader',
      state: 'completedSuccess',
      origin: 'userInput',
    } as ConversationRow)
    rows.push({
      rowId: 182,
      turnId: 't-333',
      kind: 'userInput',
      origin: 'realUser',
      text: '333',
    } as ConversationRow)
    rows.push({
      rowId: 183,
      turnId: 't-333',
      kind: 'assistantText',
      state: 'complete',
      text: '333',
    } as ConversationRow)

    const softCap = 60
    const tailOnly = capProjectionWindow(rows, softCap, 'tail')
    expect(tailOnly.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '6666')).toBe(
      false,
    )

    const pinned = ensureLiveTurnInProjectionWindow(rows, [...tailOnly], softCap)
    expect(
      pinned.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '6666'),
    ).toBe(true)
    expect(pinned.some((r) => r.kind === 'toolCall' && (r as { status?: string }).status === 'running')).toBe(
      true,
    )
  })

  it('pins buried live turn to window tail so follow-bottom shows it', () => {
    // 现场：888 provisional rowId 小于仍在追加的 777 工具 → 按 rowId 排序后
    // 窗尾是 777，跟底看不见 888；视口列表里 888 却在上面。
    const rows: ConversationRow[] = []
    rows.push({
      ...row(100, 'turnHeader'),
      turnId: 't-888',
      state: 'running',
      createdAt: 2_000,
    } as ConversationRow)
    rows.push({
      ...row(101, 'userInput', 'realUser'),
      turnId: 't-888',
      text: '888',
      createdAt: 2_000,
    } as ConversationRow)
    rows.push({
      ...row(200, 'turnHeader'),
      turnId: 't-777',
      state: 'completedSuccess',
      createdAt: 1_000,
    } as ConversationRow)
    rows.push({
      ...row(201, 'userInput', 'realUser'),
      turnId: 't-777',
      text: '777',
      createdAt: 1_000,
    } as ConversationRow)
    rows.push({
      ...row(202, 'assistantText'),
      turnId: 't-777',
      text: '777',
      state: 'complete',
      createdAt: 1_100,
    } as ConversationRow)
    for (let i = 203; i <= 260; i += 1) {
      rows.push({
        ...row(i, 'toolCall'),
        turnId: 't-777',
        status: 'success',
        createdAt: 1_100 + i,
      } as ConversationRow)
    }
    rows.push({
      ...row(261, 'toolCall'),
      turnId: 't-888',
      toolCallId: 'tc-888',
      toolName: 'platform',
      status: 'running',
      createdAt: 2_100,
    } as ConversationRow)

    const softCap = 40
    const tailOnly = capProjectionWindow(rows, softCap, 'tail')
    const pinned = ensureLiveTurnInProjectionWindow(rows, [...tailOnly], softCap)
    expect(String(pinned[pinned.length - 1]?.turnId || '')).toBe('t-888')
    expect(
      pinned.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '888'),
    ).toBe(true)
    // 窗尾连续都是 888，不能夹着 777
    let seen888 = false
    for (const r of pinned) {
      const tid = String(r.turnId || '')
      if (tid === 't-888') seen888 = true
      if (seen888) expect(tid).toBe('t-888')
    }
  })

  it('keeps earlier in-flight turn when a newer completed user sits at the tail', () => {
    // 现场：6666 工具洪峰仍在跑，窗尾却钉到后发/旧完成的 333 → 6666 整轮蒸发，
    // 流式还在回「666 收到」。liveTurnSpan 必须优先 in-flight 轮，而不是最新 realUser。
    const rows: ConversationRow[] = []
    rows.push({
      ...row(1, 'turnHeader'),
      turnId: 't-old',
      state: 'completedSuccess',
    } as ConversationRow)
    rows.push({
      ...row(2, 'userInput', 'realUser'),
      turnId: 't-old',
      text: '333',
    } as ConversationRow)
    rows.push({
      ...row(3, 'assistantText'),
      turnId: 't-old',
      text: '333',
      state: 'complete',
    } as ConversationRow)
    rows.push({
      ...row(4, 'turnHeader'),
      turnId: 't-live',
      state: 'running',
    } as ConversationRow)
    rows.push({
      ...row(5, 'userInput', 'realUser'),
      turnId: 't-live',
      text: '6666',
    } as ConversationRow)
    for (let i = 6; i <= 200; i += 1) {
      rows.push({
        ...row(i, 'toolCall'),
        turnId: 't-live',
        status: 'success',
      } as ConversationRow)
    }
    rows.push({
      ...row(201, 'toolCall'),
      turnId: 't-live',
      toolCallId: 'tc-live',
      toolName: 'platform',
      status: 'running',
    } as ConversationRow)

    const softCap = 60
    const tailOnly = capProjectionWindow(rows, softCap, 'tail')
    // 裸尾窗通常只剩工具尾，看不到 6666 用户
    expect(tailOnly.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '6666')).toBe(
      false,
    )

    const pinned = ensureLiveTurnInProjectionWindow(rows, [...tailOnly], softCap)
    expect(
      pinned.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '6666'),
    ).toBe(true)
    expect(pinned.some((r) => r.kind === 'toolCall' && (r as { status?: string }).status === 'running')).toBe(
      true,
    )
    // 不得改钉到仅完成的 333 而丢掉直播轮
    const liveUserIdx = pinned.findIndex(
      (r) => r.kind === 'userInput' && (r as { text?: string }).text === '6666',
    )
    const runningIdx = pinned.findIndex(
      (r) => r.kind === 'toolCall' && (r as { status?: string }).status === 'running',
    )
    expect(liveUserIdx).toBeGreaterThanOrEqual(0)
    expect(runningIdx).toBeGreaterThan(liveUserIdx)
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

describe('ensureLiveTurnInProjectionWindow mega live', () => {
  it('does not re-inflate a 400-row live turn already fully in window (anti #185 balloon)', () => {
    const softCap = 80
    const live: ConversationRow[] = []
    live.push({ ...row(1, 'turnHeader'), turnId: 'live', state: 'running' } as ConversationRow)
    live.push({
      ...row(2, 'userInput', 'realUser'),
      turnId: 'live',
      text: '好啦，好，我又重启好了',
    } as ConversationRow)
    for (let i = 3; i <= 400; i += 1) {
      live.push({
        ...row(i, 'toolCall'),
        turnId: 'live',
        status: 'success',
      } as ConversationRow)
    }
    // 上一问锚点
    const older: ConversationRow[] = [
      { ...row(1001, 'turnHeader'), turnId: 'older', state: 'completedSuccess' } as ConversationRow,
      {
        ...row(1002, 'userInput', 'realUser'),
        turnId: 'older',
        text: '上一问',
      } as ConversationRow,
    ]
    // rowId 交错：直播问 rowId 小、旧轮 append 大——full 按 rowId 排
    const full = [...live, ...older].sort((a, b) => a.rowId - b.rowId)
    const pinned = ensureLiveTurnInProjectionWindow(full, [...full], softCap)
    expect(pinned.length).toBeLessThanOrEqual(Math.floor(softCap * 1.5) + 8)
    expect(pinned.some((r) => r.kind === 'userInput' && String(r.text || '').includes('重启'))).toBe(
      true,
    )
    expect(pinned[pinned.length - 1]?.turnId).toBe('live')
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

  it('never drops the max rowId tip even when in-flight alone exceeds softCap', () => {
    // STREAM_AHEAD 现场：streamRow=2154 > winLast=2080 —— tip 被 in-flight 顶满路径裁掉
    const live: ConversationRow[] = []
    live.push({ ...row(1, 'turnHeader'), turnId: 'live', state: 'running' } as ConversationRow)
    live.push({
      ...row(2, 'userInput', 'realUser'),
      turnId: 'live',
      text: '还有哪些没考虑到的',
    } as ConversationRow)
    for (let i = 3; i <= 100; i += 1) {
      live.push({
        ...row(i, 'toolCall'),
        turnId: 'live',
        status: 'running',
      } as ConversationRow)
    }
    live.push({
      ...row(2154, 'toolCall'),
      turnId: 'live',
      status: 'inputStreaming',
      toolName: 'read',
    } as ConversationRow)

    const kept = selectLiveTurnWithinBudget(live, 1, 0, 40)
    expect(kept.some((r) => r.rowId === 2154)).toBe(true)
    expect(Math.max(...kept.map((r) => r.rowId))).toBe(2154)
  })
})

describe('liveTurnSpan stream tip', () => {
  it('demotes zombie low-rowId running tool when a newer tip turn already exists', () => {
    // 现场：旧轮 bash@80 永久 running；窗里已有 290+ 新 tip；只看 inflight 会钉旧轮
    // → unsorted windowLast=80、!STREAM_AHEAD_OF_WINDOW、新回复空白。
    const rows: ConversationRow[] = [
      {
        ...row(45, 'turnHeader'),
        turnId: 'zombie',
        state: 'running',
        createdAt: 1_000,
      } as ConversationRow,
      {
        ...row(46, 'userInput', 'realUser'),
        turnId: 'zombie',
        text: '旧问',
        createdAt: 1_000,
      } as ConversationRow,
      {
        ...row(80, 'toolCall'),
        turnId: 'zombie',
        status: 'running',
        toolName: 'bash',
      } as ConversationRow,
      {
        ...row(290, 'turnHeader'),
        turnId: 'tip',
        state: 'completedSuccess',
        createdAt: 9_000,
      } as ConversationRow,
      {
        ...row(291, 'userInput', 'realUser'),
        turnId: 'tip',
        text: '新问',
        createdAt: 9_000,
      } as ConversationRow,
      {
        ...row(299, 'assistantText'),
        turnId: 'tip',
        state: 'complete',
        text: '46',
      } as ConversationRow,
    ]

    const span = liveTurnSpan(rows)
    expect(span).toBeTruthy()
    expect(rows[span!.turnStart]?.turnId).toBe('tip')
    expect(rows[span!.userIdx]?.text).toBe('新问')

    const softCap = 12
    const sorted = [...rows].sort((a, b) => a.rowId - b.rowId)
    const tailOnly = capProjectionWindow(sorted, softCap, 'tail')
    const pinned = ensureLiveTurnInProjectionWindow(sorted, [...tailOnly], softCap)
    expect(pinned.some((r) => r.rowId === 299)).toBe(true)
    expect(Math.max(...pinned.map((r) => r.rowId))).toBe(299)
    expect(pinned[pinned.length - 1]?.turnId).toBe('tip')
  })

  it('prefers higher in-flight tip turn even when only the older turn has a realUser in window', () => {
    // 现场：新问还在 optimistic、投影里只有上一问「这」；SSE 已在新 turn tip=2154。
    // 旧算法按用户气泡钉旧轮 → soft-cap 裁掉 2154 → STREAM_AHEAD / 页面转圈。
    const rows: ConversationRow[] = [
      {
        ...row(2000, 'turnHeader'),
        turnId: 'old',
        state: 'running',
        createdAt: 5_000,
      } as ConversationRow,
      {
        ...row(2001, 'userInput', 'realUser'),
        turnId: 'old',
        text: '这',
        createdAt: 5_000,
      } as ConversationRow,
      {
        ...row(2080, 'toolCall'),
        turnId: 'old',
        status: 'running',
      } as ConversationRow,
      {
        ...row(2100, 'turnHeader'),
        turnId: 'new',
        state: 'running',
        createdAt: 6_000,
      } as ConversationRow,
      // 故意无 realUser：对齐「投影无此 turn / 只有 optimistic」
      {
        ...row(2154, 'toolCall'),
        turnId: 'new',
        status: 'inputStreaming',
        toolName: 'read',
      } as ConversationRow,
      {
        ...row(2366, 'toolCall'),
        turnId: 'orphan',
        status: 'success',
      } as ConversationRow,
    ]

    const span = liveTurnSpan(rows)
    expect(span).toBeTruthy()
    expect(rows[span!.turnStart]?.turnId).toBe('new')

    const softCap = 40
    const sorted = [...rows].sort((a, b) => a.rowId - b.rowId)
    const tailOnly = capProjectionWindow(sorted, softCap, 'tail')
    const pinned = ensureLiveTurnInProjectionWindow(sorted, [...tailOnly], softCap)
    expect(pinned.some((r) => r.rowId === 2154)).toBe(true)
    expect(pinned[pinned.length - 1]?.turnId).toBe('new')
    expect(Math.max(...pinned.map((r) => r.rowId))).toBeGreaterThanOrEqual(2154)
  })
})

describe('pinLiveTurnAfterDeltas', () => {
  it('moves buried 哈哈哈 ahead of late 888 rows to window tail', () => {
    // 现场：发「哈哈哈」后旧轮 888 仍有晚到 append → 窗尾仍是 888，跟底看见上轮。
    const rows: ConversationRow[] = [
      {
        ...row(10, 'turnHeader'),
        turnId: 't-hh',
        state: 'running',
        createdAt: 3_000,
      } as ConversationRow,
      {
        ...row(11, 'userInput', 'realUser'),
        turnId: 't-hh',
        text: '哈哈哈',
        createdAt: 3_000,
      } as ConversationRow,
      {
        ...row(12, 'toolCall'),
        turnId: 't-hh',
        status: 'success',
        toolName: 'platform',
        createdAt: 3_010,
      } as ConversationRow,
      {
        ...row(20, 'turnHeader'),
        turnId: 't-888',
        state: 'completedSuccess',
        createdAt: 2_000,
      } as ConversationRow,
      {
        ...row(21, 'userInput', 'realUser'),
        turnId: 't-888',
        text: '888',
        createdAt: 2_000,
      } as ConversationRow,
      {
        ...row(22, 'assistantText'),
        turnId: 't-888',
        text: '888',
        state: 'complete',
        createdAt: 2_100,
      } as ConversationRow,
      {
        ...row(23, 'toolCall'),
        turnId: 't-888',
        status: 'success',
        toolName: 'bash',
        createdAt: 2_200,
      } as ConversationRow,
    ]
    expect(String(rows[rows.length - 1]?.turnId || '')).toBe('t-888')
    const pinned = pinLiveTurnAfterDeltas(rows)
    expect(String(pinned[pinned.length - 1]?.turnId || '')).toBe('t-hh')
    expect(
      pinned.some((r) => r.kind === 'userInput' && (r as { text?: string }).text === '哈哈哈'),
    ).toBe(true)
    // 窗尾连续都是直播轮
    let seenLive = false
    for (const r of pinned) {
      const tid = String(r.turnId || '')
      if (tid === 't-hh') seenLive = true
      if (seenLive) expect(tid).toBe('t-hh')
    }
  })

  it('orders header+user before tools inside the pinned live turn', () => {
    const rows: ConversationRow[] = [
      {
        ...row(5, 'toolCall'),
        turnId: 't-live',
        status: 'running',
        toolName: 'platform',
      } as ConversationRow,
      {
        ...row(6, 'toolCall'),
        turnId: 't-live',
        status: 'success',
        toolName: 'bash',
      } as ConversationRow,
      {
        ...row(7, 'turnHeader'),
        turnId: 't-live',
        state: 'running',
        createdAt: 1,
      } as ConversationRow,
      {
        ...row(8, 'userInput', 'realUser'),
        turnId: 't-live',
        text: '哈哈哈',
        createdAt: 1,
      } as ConversationRow,
    ]
    const pinned = pinTurnRowsAtTail(rows, 't-live')
    expect(pinned[0]?.kind).toBe('turnHeader')
    expect(pinned[1]?.kind).toBe('userInput')
    expect(pinned[2]?.kind).toBe('toolCall')
  })

  it('keeps same reference when live turn already at tail (no per-delta reshuffle)', () => {
    const rows: ConversationRow[] = [
      {
        ...row(1, 'turnHeader'),
        turnId: 't-old',
        state: 'completedSuccess',
      } as ConversationRow,
      {
        ...row(2, 'userInput', 'realUser'),
        turnId: 't-old',
        text: '888',
      } as ConversationRow,
      {
        ...row(3, 'turnHeader'),
        turnId: 't-live',
        state: 'running',
        createdAt: 9,
      } as ConversationRow,
      {
        ...row(4, 'userInput', 'realUser'),
        turnId: 't-live',
        text: '好',
        createdAt: 9,
      } as ConversationRow,
      {
        ...row(5, 'toolCall'),
        turnId: 't-live',
        status: 'running',
      } as ConversationRow,
    ]
    expect(pinLiveTurnAfterDeltas(rows)).toBe(rows)
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

describe('releaseBalloonProjectionWindow', () => {
  it('returns null under balloon threshold', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i + 1))
    expect(isProjectionWindowBallooned(100, 220)).toBe(false)
    expect(releaseBalloonProjectionWindow(rows, 220)).toBeNull()
  })

  it('trims loadOlder balloon back to softCap tip (following tip)', () => {
    // 模拟上滚把 15 轮完整历史前插进窗（现场 884 行 / softCap 220）。
    const rows: ConversationRow[] = []
    let id = 1
    for (let t = 0; t < 40; t += 1) {
      const turnId = `hist-${t}`
      rows.push({ ...row(id++), turnId, kind: 'turnHeader', state: 'completedSuccess' } as ConversationRow)
      rows.push({
        ...row(id++, 'userInput', 'realUser'),
        turnId,
        text: `q${t}`,
      } as ConversationRow)
      for (let k = 0; k < 8; k += 1) {
        rows.push({
          ...row(id++, 'toolCall'),
          turnId,
          status: 'success',
        } as ConversationRow)
      }
      rows.push({
        ...row(id++, 'assistantText'),
        turnId,
        text: `a${t}`,
      } as ConversationRow)
    }
    expect(rows.length).toBeGreaterThan(330)
    expect(isProjectionWindowBallooned(rows.length, 80)).toBe(true)
    const tipId = rows[rows.length - 1]!.rowId
    const released = releaseBalloonProjectionWindow(rows, 80)
    expect(released).not.toBeNull()
    expect(released!.length).toBeLessThanOrEqual(Math.floor(80 * 1.5) + 12)
    expect(released!.length).toBeLessThan(rows.length)
    expect(released![released!.length - 1]?.rowId).toBe(tipId)
    expect(released!.some((r) => r.rowId === tipId)).toBe(true)
    // 尾轮用户问仍在（跟底可读最新）
    expect(
      released!.some(
        (r) => r.kind === 'userInput' && String((r as { text?: string }).text || '') === 'q39',
      ),
    ).toBe(true)
  })

  it('keeps max rowId tip even when a mid live turn would tempt ensureLiveTurn drop', () => {
    // 交错：较早 realUser 轮 tip=200；其后另有完成轮到 400。ensureLiveTurn
    // 若按 live 重建会丢 201…400；release 必须保 tip=400。
    const rows: ConversationRow[] = []
    for (let i = 1; i <= 200; i += 1) {
      const turnId = i <= 2 ? 'live' : i <= 100 ? 'old' : 'live'
      if (i === 1) {
        rows.push({ ...row(i), turnId: 'live', kind: 'turnHeader', state: 'completedSuccess' } as ConversationRow)
      } else if (i === 2) {
        rows.push({ ...row(i, 'userInput', 'realUser'), turnId: 'live', text: 'latest-q' } as ConversationRow)
      } else if (i <= 100) {
        rows.push({ ...row(i), turnId: 'old', kind: 'toolCall', status: 'success' } as ConversationRow)
      } else {
        rows.push({ ...row(i), turnId: 'live', kind: 'toolCall', status: 'success' } as ConversationRow)
      }
    }
    for (let i = 201; i <= 400; i += 1) {
      const turnId = 'later'
      if (i === 201) {
        rows.push({ ...row(i), turnId, kind: 'turnHeader', state: 'completedSuccess' } as ConversationRow)
      } else if (i === 202) {
        rows.push({ ...row(i, 'userInput', 'realUser'), turnId, text: 'even-later' } as ConversationRow)
      } else {
        rows.push({ ...row(i), turnId, kind: 'assistantText', text: `t${i}` } as ConversationRow)
      }
    }
    expect(isProjectionWindowBallooned(rows.length, 80)).toBe(true)
    const released = releaseBalloonProjectionWindow(rows, 80)
    expect(released).not.toBeNull()
    expect(Math.max(...released!.map((r) => r.rowId))).toBe(400)
    expect(released!.some((r) => r.rowId === 400)).toBe(true)
  })
})
