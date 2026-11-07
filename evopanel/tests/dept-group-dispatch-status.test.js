import { describe, expect, it } from 'vitest'
import {
  findWakeJobForMention,
  mergeWakeJobSnapshots,
  resolveMentionDispatchStatus,
  wakeStatusLabel,
} from '../src/react/lib/dept-group-dispatch-status.ts'

function job(partial) {
  return {
    id: 'wake-1',
    agentCode: 'fullstack',
    roleName: '全栈工程师',
    goal: '打招呼',
    status: 'done',
    attempts: 1,
    updatedAt: 100,
    ...partial,
  }
}

describe('dept-group-dispatch-status', () => {
  it('labels known statuses', () => {
    expect(wakeStatusLabel('queued')).toBe('排队中')
    expect(wakeStatusLabel('running')).toBe('回答中')
    expect(wakeStatusLabel('done')).toBe('已回')
    expect(wakeStatusLabel('failed')).toBe('失败')
    expect(wakeStatusLabel(undefined)).toBe('')
  })

  it('prefers exact sourceMsgId; else active job; never steals done from other turns', () => {
    const jobs = [
      job({ id: 'a', sourceMsgId: 'user-1', status: 'done', updatedAt: 1 }),
      job({ id: 'b', sourceMsgId: 'user-1', status: 'running', updatedAt: 2 }),
    ]
    expect(findWakeJobForMention(jobs, { agentCode: 'fullstack', sourceMsgId: 'user-1' })?.id).toBe(
      'b',
    )
    // 旧嵌套：条挂在总监气泡，job 的 source 仍是 root → 借进行中态对齐
    expect(findWakeJobForMention(jobs, { agentCode: 'fullstack', sourceMsgId: 'agent-tech-9' })?.id).toBe(
      'b',
    )
    // 只有别轮 done：不要硬套
    expect(
      findWakeJobForMention(
        [job({ id: 'a', sourceMsgId: 'user-1', status: 'done' })],
        { agentCode: 'fullstack', sourceMsgId: 'agent-tech-9' },
      ),
    ).toBe(null)
  })

  it('shows 已回 from later-reply evidence when queue empty', () => {
    const r = resolveMentionDispatchStatus({
      wakeJobs: [],
      agentCode: 'fullstack',
      sourceMsgId: 'user-1',
      hasLaterReply: true,
    })
    expect(r.label).toBe('已回')
    expect(r.miss).toBe(false)
  })

  it('shows 未入队 only when no job and no reply', () => {
    const r = resolveMentionDispatchStatus({
      wakeJobs: [],
      agentCode: 'fullstack',
      sourceMsgId: 'user-1',
      hasLaterReply: false,
    })
    expect(r.label).toBe('未入队')
    expect(r.miss).toBe(true)
  })

  it('merges live over audit by job id', () => {
    const audit = [job({ id: 'wake-1', status: 'queued', updatedAt: 1 })]
    const live = [job({ id: 'wake-1', status: 'done', updatedAt: 9 })]
    const merged = mergeWakeJobSnapshots(live, audit)
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('done')
  })
})
