import { describe, expect, it } from 'vitest'
import {
  extractMentionGoal,
  hasUnresolvedAtMentions,
  parseMentions,
} from '../src/react/lib/dept-group-mentions.ts'

const roster = [
  { agent_code: 'dev-tech-director', role_name: '技术总监' },
  { agent_code: 'dev-fullstack', role_name: '全栈工程师' },
  { agent_code: 'dev-fullsite', role_name: '全栈开发' },
  { agent_code: 'dev-qa', role_name: '测试工程师' },
]

describe('dept-group-mentions', () => {
  it('matches @name stuck to Chinese text (no space)', () => {
    const hits = parseMentions('@全栈工程师先看接口，@测试工程师验收', roster)
    expect(hits.map((h) => h.agent_code)).toEqual(['dev-fullstack', 'dev-qa'])
  })

  it('resolves legacy aliases 测试 / 后端开发 / 全站工程师', () => {
    const hits = parseMentions('@测试 改报告\n@后端开发 回一句\n@全站工程师 补页面', roster)
    expect(hits.map((h) => h.agent_code).sort()).toEqual(
      ['dev-fullstack', 'dev-qa'].sort(),
    )
  })

  it('prefers longer 测试工程师 over alias 测试', () => {
    const hits = parseMentions('@测试工程师请回归', roster)
    expect(hits).toHaveLength(1)
    expect(hits[0].agent_code).toBe('dev-qa')
  })

  it('extracts per-person goal chunks', () => {
    const text = '@全栈工程师 改登录页\n@测试工程师 回归一遍'
    const g1 = extractMentionGoal(text, roster[1])
    const g2 = extractMentionGoal(text, roster[3])
    expect(g1).toContain('登录')
    expect(g2).toContain('回归')
  })

  it('flags unresolved @ when names miss roster', () => {
    expect(hasUnresolvedAtMentions('@产品经理 看看', roster)).toBe(true)
    expect(hasUnresolvedAtMentions('@全栈工程师 看看', roster)).toBe(false)
  })
})
