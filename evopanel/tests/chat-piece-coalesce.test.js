import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  flushChatPieceCoalesce,
  scheduleChatTextPieceCoalesce,
} from '../src/lib/chat-piece-coalesce.js'

describe('chat-piece-coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges burst text pieces into one emit per rAF', () => {
    const seen = []
    scheduleChatTextPieceCoalesce('agent:main:a', 'run-1', 'hel', {}, (payload) => {
      seen.push(payload.piece)
    })
    scheduleChatTextPieceCoalesce('agent:main:a', 'run-1', 'lo', {}, (payload) => {
      seen.push(payload.piece)
    })
    expect(seen).toEqual([])
    vi.runAllTimers()
    expect(seen).toEqual(['hello'])
  })

  it('flush drains pending pieces immediately', () => {
    const seen = []
    scheduleChatTextPieceCoalesce('agent:main:b', 'run-2', 'a', {}, (payload) => {
      seen.push(payload.piece)
    })
    flushChatPieceCoalesce('agent:main:b', 'run-2', (payload) => {
      seen.push(payload.piece)
    })
    expect(seen).toEqual(['a'])
    vi.runAllTimers()
    expect(seen).toEqual(['a'])
  })
})
