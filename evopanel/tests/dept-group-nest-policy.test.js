import { describe, expect, it } from 'vitest'
import {
  canNestFurther,
  deptGroupWakeChainKey,
  headCatcherNestDepth,
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

  it('treats audience speak / 口播 handoffs as real work', () => {
    expect(
      isTrivialGroupNestGoal('你先说，给这会儿心里有点沉的家人，两三句，先陪不讲道理。'),
    ).toBe(false)
    expect(
      isTrivialGroupNestGoal('下午场，各出来跟观众打个招呼，两三句就行。'),
    ).toBe(false)
    expect(isTrivialGroupNestGoal('你收尾，把陌生感正当化')).toBe(false)
  })

  it('steward depth-0 may nest greetings; members depth≥1 may not', () => {
    const greet = '打个招呼出来说句话'
    expect(shouldAutoNestWake({ fromDepth: 0, goal: greet })).toBe(true)
    expect(shouldAutoNestWake({ fromDepth: 1, goal: greet })).toBe(false)
    expect(
      shouldAutoNestWake({ fromDepth: 1, goal: '请帮我修一下部署脚本' }),
    ).toBe(true)
    expect(
      shouldAutoNestWake({
        fromDepth: 1,
        goal: '你接上，提气一点，像带队喊号子那样两三句',
      }),
    ).toBe(true)
  })

  it('caps head-catcher depth so head can still @ specialists', () => {
    expect(headCatcherNestDepth(0, 2)).toBe(1)
    expect(headCatcherNestDepth(1, 2)).toBe(1)
    expect(headCatcherNestDepth(2, 2)).toBe(1)
    expect(headCatcherNestDepth(1, 3)).toBe(2)
  })

  it('lets department head nest one more hop at max depth', () => {
    expect(canNestFurther({ fromDepth: 1, maxDepth: 2 })).toBe(true)
    expect(canNestFurther({ fromDepth: 2, maxDepth: 2 })).toBe(false)
    expect(canNestFurther({ fromDepth: 2, maxDepth: 2, speakerIsHead: true })).toBe(true)
  })
})
