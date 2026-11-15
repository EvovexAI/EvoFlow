import { describe, expect, it } from 'vitest'
import {
  pinMaxForMemoryLevel,
  projectionSoftCapForMemoryLevel,
  resolveRendererMemoryLevel,
} from '../src/react/lib/renderer-memory-pressure.ts'

describe('resolveRendererMemoryLevel', () => {
  it('treats missing heap as normal', () => {
    expect(resolveRendererMemoryLevel(null)).toBe('normal')
    expect(resolveRendererMemoryLevel(undefined)).toBe('normal')
    expect(resolveRendererMemoryLevel(Number.NaN)).toBe('normal')
  })

  it('thresholds high / critical by heap MB', () => {
    expect(resolveRendererMemoryLevel(100)).toBe('normal')
    expect(resolveRendererMemoryLevel(512)).toBe('high')
    expect(resolveRendererMemoryLevel(700)).toBe('high')
    expect(resolveRendererMemoryLevel(768)).toBe('critical')
    expect(resolveRendererMemoryLevel(1200)).toBe('critical')
  })
})

describe('adaptive caps under memory pressure', () => {
  it('shrinks projection soft cap as pressure rises', () => {
    expect(projectionSoftCapForMemoryLevel('normal')).toBe(220)
    expect(projectionSoftCapForMemoryLevel('high')).toBe(140)
    expect(projectionSoftCapForMemoryLevel('critical')).toBe(80)
  })

  it('shrinks pin max as pressure rises', () => {
    expect(pinMaxForMemoryLevel('normal')).toBe(4)
    expect(pinMaxForMemoryLevel('high')).toBe(2)
    expect(pinMaxForMemoryLevel('critical')).toBe(1)
  })
})
