import { describe, expect, it } from 'vitest'
import {
  bumpStreamDisplayTick,
  getStreamDisplayTick,
  resetStreamDisplayTick,
  subscribeStreamDisplayTick,
} from '../src/react/lib/stream-display-tick.js'

describe('stream-display-tick', () => {
  it('notifies subscribers on bump', () => {
    resetStreamDisplayTick()
    let seen = getStreamDisplayTick()
    const unsub = subscribeStreamDisplayTick(() => {
      seen = getStreamDisplayTick()
    })
    bumpStreamDisplayTick()
    expect(seen).toBe(1)
    unsub()
  })
})
