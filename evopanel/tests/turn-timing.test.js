import { describe, expect, it } from 'vitest'
import {
  computeTurnElapsedSec,
  formatTurnDurationStr,
  formatTurnElapsedSuffix,
  formatWorkedHeadLabel,
  isGenericRunningStatusLabel,
  isTurnTimingLive,
  parseTurnTimestampMs,
  resolveStreamTailLabel,
  resolveTurnDurationLabel,
  resolveTurnStartMs,
  stripTurnDurationSuffix,
} from '../src/react/lib/turn-timing.ts'

describe('turn-timing', () => {
  it('parses ISO turn start timestamps', () => {
    const ms = parseTurnTimestampMs('2026-06-23T10:00:00.000Z')
    expect(ms).toBe(Date.parse('2026-06-23T10:00:00.000Z'))
  })

  it('computes live elapsed from DB start while running', () => {
    const startMs = Date.parse('2026-06-23T10:00:00.000Z')
    const sec = computeTurnElapsedSec(
      {
        runStatus: 'running',
        currentTurnStartedAt: '2026-06-23T10:00:00.000Z',
        currentTurnEndedAt: null,
      },
      { nowMs: startMs + 12_500 },
    )
    expect(sec).toBe(12)
  })

  it('computes frozen elapsed from DB start/end when idle', () => {
    const sec = computeTurnElapsedSec({
      runStatus: 'idle',
      currentTurnStartedAt: '2026-06-23T10:00:00.000Z',
      currentTurnEndedAt: '2026-06-23T10:00:45.000Z',
    })
    expect(sec).toBe(45)
  })

  it('uses fallbackStartMs when DB currentTurnStartedAt is missing (live + seal)', () => {
    const turnStartTs = Date.parse('2026-06-23T10:00:00.000Z')
    const liveSec = computeTurnElapsedSec(
      { runStatus: 'running', currentTurnStartedAt: null, currentTurnEndedAt: null },
      { nowMs: turnStartTs + 15_000, fallbackStartMs: turnStartTs },
    )
    expect(liveSec).toBe(15)

    const sealSec = computeTurnElapsedSec(
      { runStatus: 'idle', currentTurnStartedAt: null, currentTurnEndedAt: null },
      { endMs: turnStartTs + 15_200, fallbackStartMs: turnStartTs },
    )
    expect(sealSec).toBe(15)
  })

  it('prefers DB currentTurnStartedAt over fallbackStartMs', () => {
    const dbStart = Date.parse('2026-06-23T10:00:00.000Z')
    const fallback = dbStart - 60_000
    expect(resolveTurnStartMs({ currentTurnStartedAt: '2026-06-23T10:00:00.000Z' }, fallback)).toBe(
      dbStart,
    )
    const sec = computeTurnElapsedSec(
      {
        runStatus: 'running',
        currentTurnStartedAt: '2026-06-23T10:00:00.000Z',
        currentTurnEndedAt: null,
      },
      { nowMs: dbStart + 10_000, fallbackStartMs: fallback },
    )
    expect(sec).toBe(10)
  })

  it('returns undefined when start is unavailable', () => {
    expect(
      computeTurnElapsedSec(
        { runStatus: 'running', currentTurnStartedAt: null, currentTurnEndedAt: null },
        { nowMs: Date.now() },
      ),
    ).toBeUndefined()
  })

  it('formats duration and suffix consistently', () => {
    expect(formatTurnDurationStr(12)).toBe('12s')
    expect(formatTurnDurationStr(65)).toBe('1m05s')
    expect(formatTurnElapsedSuffix(65)).toBe(' · 1m05s')
  })

  it('resolves duration label from raw elapsedSec before dock parse', () => {
    expect(
      resolveTurnDurationLabel({
        elapsedSec: 92,
        sealedDurationStr: '1s',
        dockLabelCompat: '推理中 · 9s',
      }),
    ).toBe('1m32s')
  })

  it('falls back to sealed durationStr then dock compat parse', () => {
    expect(resolveTurnDurationLabel({ sealedDurationStr: '45s' })).toBe('45s')
    expect(
      resolveTurnDurationLabel({
        dockLabelCompat: '运行中 · 12s',
      }),
    ).toBe('12s')
  })

  it('strips trailing duration from dock status copy', () => {
    expect(stripTurnDurationSuffix('推理中 · 1m32s')).toBe('推理中')
    expect(stripTurnDurationSuffix('运行中 · 12s')).toBe('运行中')
    expect(stripTurnDurationSuffix('调用：read')).toBe('调用：read')
  })

  it('detects live turn timing from session row', () => {
    expect(
      isTurnTimingLive({
        runStatus: 'running',
        currentTurnStartedAt: '2026-06-23T10:00:00.000Z',
        currentTurnEndedAt: null,
      }),
    ).toBe(true)
    expect(
      isTurnTimingLive({
        runStatus: 'idle',
        currentTurnStartedAt: '2026-06-23T10:00:00.000Z',
        currentTurnEndedAt: '2026-06-23T10:00:45.000Z',
      }),
    ).toBe(false)
  })
})

describe('formatWorkedHeadLabel（折叠头带最后一步）', () => {
  it('已工作时长 + 最后一步文案', () => {
    expect(formatWorkedHeadLabel('11m29s', '执行工具 web_search')).toBe(
      '已工作 11 分 29 秒 · 执行工具 web_search',
    )
  })

  it('无最后一步时退回纯「已工作」头', () => {
    expect(formatWorkedHeadLabel('11m29s', '')).toBe('已工作 11 分 29 秒')
    expect(formatWorkedHeadLabel('11m29s', null)).toBe('已工作 11 分 29 秒')
  })

  it('时长解析失败返回空串（调用方退回平铺）', () => {
    expect(formatWorkedHeadLabel('', 'xx')).toBe('')
    expect(formatWorkedHeadLabel(null, 'xx')).toBe('')
  })
})

describe('resolveStreamTailLabel（流式尾部 spinner 文案）', () => {
  it('剥离实时活动里的耗时后缀', () => {
    expect(resolveStreamTailLabel('执行工具 web_search · 45s')).toBe('执行工具 web_search')
    expect(resolveStreamTailLabel('推理中 · 1m32s')).toBe('推理中')
  })

  it('无耗时后缀的原样透传', () => {
    expect(resolveStreamTailLabel('生成中…')).toBe('生成中…')
    expect(resolveStreamTailLabel('正在联网搜索 BPM…')).toBe('正在联网搜索 BPM…')
  })

  it('空值退回默认「生成中」', () => {
    expect(resolveStreamTailLabel('')).toBe('生成中')
    expect(resolveStreamTailLabel(undefined)).toBe('生成中')
    expect(resolveStreamTailLabel('· 45s')).toBe('生成中')
  })
})

describe('isGenericRunningStatusLabel（忙闲兜底，不进封存头）', () => {
  it('识别运行中/工作中等通用忙文案', () => {
    expect(isGenericRunningStatusLabel('运行中')).toBe(true)
    expect(isGenericRunningStatusLabel('运行中 · 1s')).toBe(true)
    expect(isGenericRunningStatusLabel('工作中')).toBe(true)
    expect(isGenericRunningStatusLabel('生成中')).toBe(true)
  })

  it('具体工具活动不算通用忙文案', () => {
    expect(isGenericRunningStatusLabel('执行工具 web_search')).toBe(false)
    expect(isGenericRunningStatusLabel('推理中')).toBe(false)
  })
})
