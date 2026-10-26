import { describe, expect, it } from 'vitest'
import { AGENT_SOURCE_OPTIONS, agentSourceOf } from '../src/pages/agents-shared.js'

describe('AGENT_SOURCE_OPTIONS', () => {
  it('每个来源选项都有非空 label(下拉不允许空白项)', () => {
    for (const o of AGENT_SOURCE_OPTIONS) {
      expect(o.label, `来源选项 ${o.key} 的 label 不应为空`).toBeTruthy()
    }
  })

  it('custom 来源显示为「自定义」', () => {
    const custom = AGENT_SOURCE_OPTIONS.find((o) => o.key === 'custom')
    expect(custom?.label).toBe('自定义')
  })

  it('筛选 chip 优先显示 label 而非 key', () => {
    const key = 'custom'
    const o = AGENT_SOURCE_OPTIONS.find((x) => x.key === key)
    expect(o?.label || key).toBe('自定义')
  })
})

describe('agentSourceOf', () => {
  it('普通自建岗归为 custom', () => {
    expect(agentSourceOf({ agent_code: 'my-bot', agent_type: '' })).toBe('custom')
  })

  it('main / subagent 归为 system', () => {
    expect(agentSourceOf({ agent_code: 'main' })).toBe('system')
    expect(agentSourceOf({ agent_code: 'x', agent_type: 'subagent' })).toBe('system')
  })

  it('skillhub 标签归为 skillhub', () => {
    expect(agentSourceOf({ agent_code: 'x', tags: ['SkillHub'] })).toBe('skillhub')
  })
})
