/**
 * Pre-send stale-thread perception: after Agent Runtime reload, FE must not
 * trust a cached lead UUID until the session is re-verified (force_recreate).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

describe('markLangGraphThreadsStale / epoch', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('bumps epoch and exports getters', async () => {
    const mod = await import('../src/lib/ws-client.js')
    const before = mod.getLangGraphThreadEpoch()
    const next = mod.markLangGraphThreadsStale('test_reload')
    expect(next).toBe(before + 1)
    expect(mod.getLangGraphThreadEpoch()).toBe(before + 1)
    const next2 = mod.markLangGraphThreadsStale('stream_404')
    expect(next2).toBe(before + 2)
  })
})
