import { describe, expect, it } from 'vitest'
import {
  heavyHorizonForMemoryLevel,
  memoryWatchIntervalMs,
  pinMaxForMemoryLevel,
  projectionSoftCapForMemoryLevel,
  resolveRendererMemoryLevel,
  shouldContinueCriticalEviction,
} from '../src/react/lib/renderer-memory-pressure.ts'

describe('resolveRendererMemoryLevel', () => {
  it('treats missing heap as normal', () => {
    expect(resolveRendererMemoryLevel(null)).toBe('normal')
    expect(resolveRendererMemoryLevel(undefined)).toBe('normal')
    expect(resolveRendererMemoryLevel(Number.NaN)).toBe('normal')
  })

  it('thresholds high / critical early enough to leave headroom', () => {
    expect(resolveRendererMemoryLevel(100)).toBe('normal')
    expect(resolveRendererMemoryLevel(384)).toBe('high')
    expect(resolveRendererMemoryLevel(500)).toBe('high')
    expect(resolveRendererMemoryLevel(512)).toBe('critical')
    expect(resolveRendererMemoryLevel(1200)).toBe('critical')
  })
})

describe('adaptive caps under memory pressure', () => {
  it('holds full-window soft cap at all memory levels (ZCode align 2026-11-22)', () => {
    // 行数软顶已退役；内存安全靠 lighten + pin 驱逐，不按水位裁窗。
    expect(projectionSoftCapForMemoryLevel('normal')).toBe(100_000)
    expect(projectionSoftCapForMemoryLevel('high')).toBe(100_000)
    expect(projectionSoftCapForMemoryLevel('critical')).toBe(100_000)
  })

  it('shrinks pin max as pressure rises', () => {
    expect(pinMaxForMemoryLevel('normal')).toBe(6)
    expect(pinMaxForMemoryLevel('high')).toBe(2)
    expect(pinMaxForMemoryLevel('critical')).toBe(1)
  })

  it('polls faster under pressure', () => {
    expect(memoryWatchIntervalMs('normal')).toBe(15_000)
    expect(memoryWatchIntervalMs('high')).toBe(5_000)
    expect(memoryWatchIntervalMs('critical')).toBe(2_000)
  })

  it('tightens heavy horizon under pressure', () => {
    expect(heavyHorizonForMemoryLevel('normal')).toBe(60)
    expect(heavyHorizonForMemoryLevel('high')).toBe(36)
    expect(heavyHorizonForMemoryLevel('critical')).toBe(20)
  })

  it('continues critical eviction while heap rises, stops when it falls', () => {
    expect(shouldContinueCriticalEviction(900)).toBe(true)
    expect(shouldContinueCriticalEviction(950)).toBe(true)
    // 抖动 ≤8MB 仍算未回落
    expect(shouldContinueCriticalEviction(945)).toBe(true)
    expect(shouldContinueCriticalEviction(800)).toBe(false)
  })
})
