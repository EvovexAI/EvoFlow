import { describe, expect, it } from 'vitest'
import {
  deptGroupWakeChainKey,
  isTrivialGroupNestGoal,
  shouldAutoNestWake,
} from '../src/react/lib/dept-group-nest-policy.ts'

describe('dept-group-nest-policy', () => {
  it('builds root-scoped per-target chain keys', () => {
    expect(deptGroupWakeChainKey('user-1', 'fullstack')).toBe('user-1|->fullstack')
    expect(deptGroupWakeChainKey('user-1', 'tech')).toBe('user-1|->tech')
  })

  it('uses separate work keys so greeting then real handoff can re-wake', () => {
    const greet = deptGroupWakeChainKey('user-1', 'fullstack', {
      fromAgentCode: 'xiaomi',
      goal: '打个招呼',
    })
    const work = deptGroupWakeChainKey('user-1', 'fullstack', {
      fromAgentCode: 'tech',
      goal: '按这七条返工：侧栏补图标并持久化',
    })
    expect(greet).toBe('user-1|->fullstack')
    expect(work.startsWith('user-1|work|')).toBe(true)
    expect(work).not.toBe(greet)
  })

  it('treats greeting / hello goals as trivial', () => {
    expect(isTrivialGroupNestGoal('用户想让你在群里回个话，打个招呼。')).toBe(true)
    expect(isTrivialGroupNestGoal('你也出来说句话打个招呼')).toBe(true)
    expect(isTrivialGroupNestGoal('收到')).toBe(true)
    expect(isTrivialGroupNestGoal('在呢在呢')).toBe(true)
    expect(isTrivialGroupNestGoal('老板找你，出来回一声。')).toBe(true)
    expect(isTrivialGroupNestGoal('出来跟老板打个招呼，一句话就行')).toBe(true)
  })

  it('allows real handoff goals', () => {
    expect(isTrivialGroupNestGoal('请帮忙改一下登录接口的 500')).toBe(false)
    expect(isTrivialGroupNestGoal('接手排查工作台白屏，并交付修复')).toBe(false)
  })

  it('steward depth-0 may nest greetings; members depth≥1 may not', () => {
    const greet = '打个招呼出来说句话'
    expect(shouldAutoNestWake({ fromDepth: 0, goal: greet })).toBe(true)
    expect(shouldAutoNestWake({ fromDepth: 1, goal: greet })).toBe(false)
    expect(
      shouldAutoNestWake({ fromDepth: 1, goal: '请帮我修一下部署脚本' }),
    ).toBe(true)
  })
})
