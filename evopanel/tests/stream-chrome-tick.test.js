import { describe, expect, it } from 'vitest'
import {
  bumpStreamChromeTick,
  getStreamChromeTick,
  resetStreamChromeTick,
  subscribeStreamChromeTick,
} from '../src/react/lib/stream-chrome-tick.js'

describe('stream-chrome-tick', () => {
  it('notifies subscribers on bump', () => {
    resetStreamChromeTick()
    let seen = getStreamChromeTick()
    const unsub = subscribeStreamChromeTick(() => {
      seen = getStreamChromeTick()
    })
    bumpStreamChromeTick()
    expect(seen).toBe(1)
    unsub()
  })
})
