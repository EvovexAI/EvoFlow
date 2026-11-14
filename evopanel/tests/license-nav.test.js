import { describe, expect, it, beforeEach } from 'vitest'
import {
  isPremiumActive,
  isPremiumRoute,
  setLicenseStatus,
  getLicenseStatus,
} from '../src/lib/license.js'
import { showTaskCenterNav, showAppsNav, showProactiveNav } from '../src/lib/nav-visibility.js'

describe('license entitlements (frontend)', () => {
  beforeEach(() => {
    setLicenseStatus(null)
  })

  it('premium routes detected', () => {
    expect(isPremiumRoute('/tasks')).toBe(true)
    expect(isPremiumRoute('/task/abc')).toBe(true)
    expect(isPremiumRoute('/apps')).toBe(true)
    expect(isPremiumRoute('/apps/x/run')).toBe(true)
    expect(isPremiumRoute('/proactive')).toBe(true)
    expect(isPremiumRoute('/proactive/pm')).toBe(true)
    expect(isPremiumRoute('/chat')).toBe(false)
    expect(isPremiumRoute('/settings')).toBe(false)
  })

  it('nav always visible; license gate disabled keeps premium active', () => {
    // LICENSE_GATE_ENABLED=false（公开发布默认关闸）：不拦截高级路由，
    // isPremiumActive 恒为 true；改回 true 才恢复 premium 校验。
    expect(isPremiumActive()).toBe(true)
    expect(showTaskCenterNav()).toBe(true)
    expect(showAppsNav()).toBe(true)
    expect(showProactiveNav()).toBe(true)

    setLicenseStatus({
      machine_id: 'ABCDEF0123456789',
      activated: true,
      expires_at: '2099-01-01T00:00:00Z',
      features: ['premium'],
      status: 'active',
      activated_at: '2026-01-01T00:00:00Z',
      premium: true,
    })
    expect(getLicenseStatus()?.premium).toBe(true)
    expect(isPremiumActive()).toBe(true)
    expect(showTaskCenterNav()).toBe(true)
  })
})
