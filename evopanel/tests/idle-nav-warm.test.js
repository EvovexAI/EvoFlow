import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

// idle-nav-warm：boot 后空闲预热高频菜单模块，只 warm 模块不预取数据。
// prefetchRoute 依赖 hash 路由表（registerRoute），测试里注册假 loader 验证调用面。

vi.mock('../src/router.js', () => ({
  prefetchRoute: vi.fn(() => Promise.resolve({ render: () => '' })),
}))

import { prefetchRoute } from '../src/router.js'

const EXPECTED_WARM = [
  '/tasks',
  '/apps',
  '/apps/__warm__',
  '/proactive',
  '/knowledge',
  '/assets',
  '/cron',
  '/expert',
  '/models',
  '/settings',
  '/logs',
  '/observability',
]

describe('idle-nav-warm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('warms frequent menu + secondary pattern routes once', async () => {
    vi.resetModules()
    const { warmFrequentMenuModules } = await import('../src/boot/idle-nav-warm.js')
    warmFrequentMenuModules()
    // Fallback path: setTimeout(run, 900) then 180ms between each route.
    await vi.advanceTimersByTimeAsync(900)
    for (let i = 0; i < EXPECTED_WARM.length; i++) {
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(prefetchRoute).toHaveBeenCalledTimes(EXPECTED_WARM.length)
    const warmed = prefetchRoute.mock.calls.map((c) => c[0])
    for (const p of EXPECTED_WARM) {
      expect(warmed).toContain(p)
    }
  })

  it('is idempotent — second call warms nothing again', async () => {
    vi.resetModules()
    const { warmFrequentMenuModules } = await import('../src/boot/idle-nav-warm.js')
    warmFrequentMenuModules()
    warmFrequentMenuModules()
    await vi.advanceTimersByTimeAsync(50)
    expect(prefetchRoute).not.toHaveBeenCalled()
  })

  it('prefetchRoute rejection does not break the warm loop', async () => {
    prefetchRoute.mockImplementation(() => Promise.reject(new Error('cold')))
    vi.resetModules()
    const { warmFrequentMenuModules: warmAgain } = await import('../src/boot/idle-nav-warm.js')
    expect(() => warmAgain()).not.toThrow()
    await vi.advanceTimersByTimeAsync(900)
    for (let i = 0; i < EXPECTED_WARM.length; i++) {
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(prefetchRoute.mock.calls.length).toBeGreaterThanOrEqual(EXPECTED_WARM.length)
  })
})
