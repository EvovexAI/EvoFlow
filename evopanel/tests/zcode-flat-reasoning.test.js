import { describe, expect, it } from 'vitest'
import {
  formatReasoningDurationLabel,
  formatWorkedDurationLabel,
} from '../src/react/lib/turn-timing.ts'
import {
  closeBlockInState,
  segmentsFromBlockState,
  upsertBlockInState,
} from '../src/react/lib/content-blocks.ts'
import {
  emptyStreamTurn,
  reduceStreamTurn,
} from '../src/react/lib/stream-turn-engine.ts'

describe('formatReasoningDurationLabel（ZCode「持续了 X 秒」）', () => {
  it('returns empty for missing/invalid durations', () => {
    expect(formatReasoningDurationLabel(null)).toBe('')
    expect(formatReasoningDurationLabel(undefined)).toBe('')
    expect(formatReasoningDurationLabel(0)).toBe('')
    expect(formatReasoningDurationLabel(-3)).toBe('')
    expect(formatReasoningDurationLabel(NaN)).toBe('')
  })

  it('formats seconds', () => {
    expect(formatReasoningDurationLabel(400)).toBe('')
    expect(formatReasoningDurationLabel(800)).toBe('持续了 1 秒')
    expect(formatReasoningDurationLabel(16_400)).toBe('持续了 16 秒')
    expect(formatReasoningDurationLabel(59_600)).toBe('持续了 1 分')
  })

  it('formats minutes with padded seconds', () => {
    expect(formatReasoningDurationLabel(61_000)).toBe('持续了 1 分 01 秒')
    expect(formatReasoningDurationLabel(136_000)).toBe('持续了 2 分 16 秒')
    expect(formatReasoningDurationLabel(120_000)).toBe('持续了 2 分')
  })

  it('formats hours', () => {
    expect(formatReasoningDurationLabel(3_600_000)).toBe('持续了 1 小时')
    expect(formatReasoningDurationLabel(3_720_000)).toBe('持续了 1 小时 2 分')
  })
})

describe('formatWorkedDurationLabel（ZCode「已工作 X 分 X 秒」）', () => {
  it('parses formatTurnDurationStr shapes', () => {
    expect(formatWorkedDurationLabel('12s')).toBe('已工作 12 秒')
    expect(formatWorkedDurationLabel('5m22s')).toBe('已工作 5 分 22 秒')
    expect(formatWorkedDurationLabel('1m05s')).toBe('已工作 1 分 5 秒')
    expect(formatWorkedDurationLabel('1h2m3s')).toBe('已工作 1 小时 2 分 3 秒')
    expect(formatWorkedDurationLabel('2m')).toBe('已工作 2 分')
  })

  it('returns empty for missing/invalid labels', () => {
    expect(formatWorkedDurationLabel('')).toBe('')
    expect(formatWorkedDurationLabel(null)).toBe('')
    expect(formatWorkedDurationLabel(undefined)).toBe('')
    expect(formatWorkedDurationLabel('soon')).toBe('')
    expect(formatWorkedDurationLabel('0s')).toBe('')
  })
})

describe('block 路径思考计时', () => {
  it('upsert 盖 startedAtMs，close 盖 endedAtMs，segments 透传', async () => {
    const wire = { blockId: 'r:b1', blockKind: 'reasoning', seq: 1 }
    let state = { blocks: {}, blockOrder: [] }
    const opened = upsertBlockInState(state, wire, { text: '思考中' })
    const block = opened.blocks['r:b1']
    expect(typeof block.startedAtMs).toBe('number')
    expect(block.endedAtMs).toBeUndefined()

    const closed = closeBlockInState(opened, wire)
    const closedBlock = closed.blocks['r:b1']
    expect(typeof closedBlock.endedAtMs).toBe('number')
    expect(closedBlock.endedAtMs).toBeGreaterThanOrEqual(closedBlock.startedAtMs)

    const segs = segmentsFromBlockState(closed.blocks, closed.blockOrder)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe('reasoning')
    expect(segs[0].startedAtMs).toBe(closedBlock.startedAtMs)
    expect(segs[0].endedAtMs).toBe(closedBlock.endedAtMs)
  })

  it('重复 close 不覆盖首个 endedAtMs', async () => {
    const wire = { blockId: 'r:b1', blockKind: 'reasoning', seq: 1 }
    const opened = upsertBlockInState({ blocks: {}, blockOrder: [] }, wire, { text: 'x' })
    const closed1 = closeBlockInState(opened, wire)
    const firstEnd = closed1.blocks['r:b1'].endedAtMs
    const closed2 = closeBlockInState(closed1, wire)
    expect(closed2.blocks['r:b1'].endedAtMs).toBe(firstEnd)
  })
})

describe('legacy 时间线路径思考计时', () => {
  it('reasoning_piece 盖 startedAtMs；tools 到达盖 endedAtMs', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '第一段思考' })
    expect(s.timeline).toHaveLength(1)
    expect(s.timeline[0].kind).toBe('reasoning')
    expect(typeof s.timeline[0].startedAtMs).toBe('number')
    expect(s.timeline[0].endedAtMs).toBeUndefined()

    const startedAt = s.timeline[0].startedAtMs
    // 同段合并保留 startedAtMs
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '继续思考' })
    expect(s.timeline[0].startedAtMs).toBe(startedAt)

    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'call_1', name: 'bash', input: { command: 'ls' } }],
    })
    expect(s.timeline.some((seg) => seg.kind === 'tools')).toBe(true)
    const reasoningSeg = s.timeline.find((seg) => seg.kind === 'reasoning')
    expect(typeof reasoningSeg.endedAtMs).toBe('number')
    expect(reasoningSeg.endedAtMs).toBeGreaterThanOrEqual(reasoningSeg.startedAtMs)
  })

  it('正文 piece 到达同样关掉末尾思考段', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '想一下' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '正文开始' })
    const reasoningSeg = s.timeline.find((seg) => seg.kind === 'reasoning')
    expect(reasoningSeg).toBeTruthy()
    expect(typeof reasoningSeg.endedAtMs).toBe('number')
  })

  it('工具后的新一轮思考独立计时', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '第一轮' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'call_1', name: 'bash', input: { command: 'ls' } }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '第二轮' })
    const reasoningSegs = s.timeline.filter((seg) => seg.kind === 'reasoning')
    expect(reasoningSegs).toHaveLength(2)
    expect(reasoningSegs[0].endedAtMs).not.toBeNull()
    expect(reasoningSegs[1].endedAtMs).toBeUndefined()
    expect(reasoningSegs[1].startedAtMs).toBeGreaterThanOrEqual(reasoningSegs[0].endedAtMs)
  })
})
