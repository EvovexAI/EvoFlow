import { describe, expect, it } from 'vitest'
import { resolveMessageRowIsStreaming } from '../src/react/lib/message-row-streaming.ts'

describe('resolveMessageRowIsStreaming', () => {
  it('true only for continued row while stream active', () => {
    expect(resolveMessageRowIsStreaming(2, 2, true)).toBe(true)
    expect(resolveMessageRowIsStreaming(2, 2, false)).toBe(false)
    expect(resolveMessageRowIsStreaming(1, 2, true)).toBe(false)
    expect(resolveMessageRowIsStreaming(2, -1, true)).toBe(false)
  })
})
