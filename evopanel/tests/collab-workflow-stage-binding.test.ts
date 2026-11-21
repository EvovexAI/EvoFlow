// 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
// 为什么写这条：现网右栏「工作流」签在 platform ui.show 指定 mainTaskId 的情况下，
// 显示的却是**另一个任务**的标题、节点数 0。根因是 leadThreadId 回落到「当前会话 thread」，
// 而 fetchCollabTaskRow 的解析顺序是 sessionKey → threadId → preferTaskId，前两条先命中。
// 判据：显式给了任务，就必须按它绑；只有没显式给时才可以借当前会话。
import { describe, expect, it } from 'vitest'
import { resolveCollabWorkflowStageBinding } from '../src/lib/right-stage/collab-workflow-stage-binding.ts'

describe('工作流签任务绑定', () => {
  it('显式 mainTaskId 时不继承当前会话 thread（现网缺陷回归）', () => {
    // 真实场景：ui.show collab-workflow mainTaskId=2611211657_7112，
    // 当前会话 fallback 指向另一个任务 → 旧代码会把 leadThreadId 串成当前会话的 thread，
    // 按 thread 反查到别的任务行，标题和节点全错。
    const got = resolveCollabWorkflowStageBinding({
      surfaceData: { mainTaskId: '2611211657_7112' },
      fallbackMainTaskId: '2611211509_9f31',
      fallbackLeadThreadId: 'thread-current-session',
      sharedMainTask: { taskId: '2611211509_9f31' },
    })
    expect(got.mainTaskId).toBe('2611211657_7112')
    expect(got.leadThreadId).toBe('')
    expect(got.useShared).toBe(false)
  })

  it('显式 mainTaskId + 显式 leadThreadId 时照用它', () => {
    const got = resolveCollabWorkflowStageBinding({
      surfaceData: { mainTaskId: 't-1', leadThreadId: 'thread-own' },
      fallbackLeadThreadId: 'thread-current-session',
    })
    expect(got.leadThreadId).toBe('thread-own')
  })

  it('未显式给任务时仍可借当前会话（不破坏原行为）', () => {
    const got = resolveCollabWorkflowStageBinding({
      surfaceData: {},
      fallbackMainTaskId: 't-cur',
      fallbackLeadThreadId: 'thread-current-session',
      sharedMainTask: { taskId: 't-cur' },
    })
    expect(got.mainTaskId).toBe('t-cur')
    expect(got.leadThreadId).toBe('thread-current-session')
    expect(got.useShared).toBe(true)
  })

  it('全空时给出空绑定且不共享', () => {
    const got = resolveCollabWorkflowStageBinding({ surfaceData: null })
    expect(got).toEqual({ mainTaskId: '', leadThreadId: '', useShared: false })
  })
})
