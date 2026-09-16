import { describe, expect, it } from 'vitest'
import {
  developerAgentStatusLabel,
  developerAgentStatusTone,
  pickCursorAgent,
} from '../src/lib/developer-agents.js'

describe('developer-agents helpers', () => {
  it('maps preflight statuses to Chinese labels', () => {
    expect(developerAgentStatusLabel('ready')).toBe('已连接')
    expect(developerAgentStatusLabel('authentication_required')).toBe('需要登录')
    expect(developerAgentStatusLabel('unavailable')).toBe('未安装')
    expect(developerAgentStatusLabel('unhealthy')).toBe('异常')
  })

  it('maps statuses to badge tones', () => {
    expect(developerAgentStatusTone('ready')).toBe('ok')
    expect(developerAgentStatusTone('authentication_required')).toBe('warn')
    expect(developerAgentStatusTone('unhealthy')).toBe('danger')
    expect(developerAgentStatusTone('unavailable')).toBe('muted')
  })

  it('picks the cursor provider from the agents list', () => {
    const cursor = pickCursorAgent({
      agents: [
        { provider: 'other', status: 'unavailable' },
        { provider: 'cursor', status: 'ready', available: true },
      ],
    })
    expect(cursor?.provider).toBe('cursor')
    expect(cursor?.status).toBe('ready')
  })
})
