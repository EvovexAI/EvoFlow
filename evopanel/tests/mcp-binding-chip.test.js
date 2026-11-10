import { describe, expect, it } from 'vitest'
import { resolveMcpBindingChip } from '../src/lib/mcp-workbench-link.js'

describe('resolveMcpBindingChip', () => {
  it('treats null/undefined as inherit-all (show global count)', () => {
    expect(resolveMcpBindingChip(null, 5)).toEqual({
      count: 5,
      mode: 'inherit',
      names: [],
    })
    expect(resolveMcpBindingChip(undefined, 3).mode).toBe('inherit')
  })

  it('treats explicit empty array as unbound (0), not global catalog', () => {
    expect(resolveMcpBindingChip([], 5)).toEqual({
      count: 0,
      mode: 'empty',
      names: [],
    })
  })

  it('counts allowlisted servers', () => {
    expect(resolveMcpBindingChip(['ai-canvas-director', 'ecommerce-shangce'], 5)).toEqual({
      count: 2,
      mode: 'allowlist',
      names: ['ai-canvas-director', 'ecommerce-shangce'],
    })
  })
})
