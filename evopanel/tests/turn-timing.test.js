import { describe, expect, it } from 'vitest'
import {
  computeTurnElapsedSec,
  formatTurnDurationStr,
  formatTurnElapsedSuffix,
  isTurnTimingLive,
  parseTurnTimestampMs,
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
