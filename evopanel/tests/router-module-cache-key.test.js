import { describe, expect, it } from 'vitest'
import { routeModuleCacheKey } from '../src/router.js'

describe('routeModuleCacheKey', () => {
  it('collapses dynamic app / proactive / agent paths onto patterns', () => {
    expect(routeModuleCacheKey('/apps/foo')).toBe('/apps/:id')
    expect(routeModuleCacheKey('/apps/bar/run')).toBe('/apps/:id/run')
    expect(routeModuleCacheKey('/apps/bar/history')).toBe('/apps/:id/history')
    expect(routeModuleCacheKey('/proactive/coder')).toBe('/proactive/:code')
    expect(routeModuleCacheKey('/proactive/coder/item/x')).toBe('/proactive/:code/item/:itemId')
    expect(routeModuleCacheKey('/agents/alice')).toBe('/agents/:code')
    expect(routeModuleCacheKey('/task/abc')).toBe('/task/:id')
  })

  it('keeps static menu paths as-is', () => {
    expect(routeModuleCacheKey('/tasks')).toBe('/tasks')
    expect(routeModuleCacheKey('/apps')).toBe('/apps')
    expect(routeModuleCacheKey('/chat')).toBe('/chat')
    expect(routeModuleCacheKey('/settings?tab=x')).toBe('/settings')
  })
})
