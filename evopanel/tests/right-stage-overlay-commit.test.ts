import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  clearAllRightStageOverlayDefer,
  commitRightStageClose,
  commitRightStageOpen,
  resumeStreamBumpIfIdle,
  setRightStageOverlayDefer,
} from '../src/lib/right-stage/right-stage-overlay-commit.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../src/lib/chat-overlay-defer.js'

vi.mock('react-dom', () => ({
  flushSync: (fn: () => void) => fn(),
}))

beforeEach(() => {
  clearAllRightStageOverlayDefer()
  setChatOverlayDefer('unrelated', false)
})

describe('right-stage-overlay-commit', () => {
  it('commitRightStageOpen defers then runs mutate', () => {
    const order: string[] = []
    commitRightStageOpen('workspace', () => {
      expect(isChatOverlayDeferActive()).toBe(true)
      order.push('mutate')
    })
    expect(order).toEqual(['mutate'])
    expect(isChatOverlayDeferActive()).toBe(true)
  })

  it('commitRightStageClose clears defer and resumes bump when idle', () => {
    setRightStageOverlayDefer('workspace', true)
    const bump = vi.fn()
    commitRightStageClose({
      clearDefer: 'workspace',
      flush: false,
      mutate: () => undefined,
      resumeBump: bump,
    })
    expect(isChatOverlayDeferActive()).toBe(false)
    expect(bump).toHaveBeenCalledTimes(1)
  })

  it('resumeStreamBumpIfIdle waits while another overlay is active', () => {
    setRightStageOverlayDefer(['workspace', 'workflow'], true)
    setRightStageOverlayDefer('workspace', false)
    const bump = vi.fn()
    resumeStreamBumpIfIdle(bump)
    expect(bump).not.toHaveBeenCalled()
    setRightStageOverlayDefer('workflow', false)
    resumeStreamBumpIfIdle(bump)
    expect(bump).toHaveBeenCalledTimes(1)
  })
})
