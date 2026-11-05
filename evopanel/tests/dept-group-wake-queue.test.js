import { describe, expect, it, vi } from 'vitest'
import {
  DeptGroupWakeQueue,
  isWakeBusyError,
  normalizeWakeGoal,
} from '../src/react/lib/dept-group-wake-queue.ts'

describe('dept-group-wake-queue helpers', () => {
  it('detects busy errors', () => {
    expect(isWakeBusyError(new Error('409 already running'))).toBe(true)
    expect(isWakeBusyError(new Error('正在巡检'))).toBe(true)
    expect(isWakeBusyError(new Error('network down'))).toBe(false)
  })

  it('normalizes goals for merge', () => {
    expect(normalizeWakeGoal('  改  报告  ')).toBe('改 报告')
  })
})

describe('DeptGroupWakeQueue', () => {
  it('runs different agents in parallel, same agent serially', async () => {
    const active = []
    const maxActive = { n: 0 }
    const order = []
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async (input) => {
        active.push(input.agentCode)
        maxActive.n = Math.max(maxActive.n, active.length)
        order.push(`start:${input.agentCode}:${input.goal}`)
        await sleep(30)
        order.push(`end:${input.agentCode}:${input.goal}`)
        active.splice(active.indexOf(input.agentCode), 1)
      },
    })

    await Promise.all([
      q.enqueue({ agentCode: 'a', roleName: 'A', goal: 'g1', depth: 0 }),
      q.enqueue({ agentCode: 'a', roleName: 'A', goal: 'g2', depth: 0 }),
      q.enqueue({ agentCode: 'b', roleName: 'B', goal: 'g3', depth: 0 }),
    ])

    expect(maxActive.n).toBeLessThanOrEqual(2)
    const aStarts = order.filter((x) => x.startsWith('start:a:')).map((x) => x.slice(8))
    expect(aStarts).toEqual(['g1', 'g2'])
    const a1end = order.indexOf('end:a:g1')
    const a2start = order.indexOf('start:a:g2')
    expect(a1end).toBeGreaterThanOrEqual(0)
    expect(a2start).toBeGreaterThan(a1end)
    q.dispose()
  })

  it('retries busy then succeeds', async () => {
    let n = 0
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async () => {
        n += 1
        if (n < 3) return { busy: true, error: 'busy' }
        return {}
      },
    })
    await q.enqueue({ agentCode: 'x', roleName: 'X', goal: 'hello', depth: 0 })
    expect(n).toBe(3)
    const snap = q.snapshot().find((j) => j.agentCode === 'x')
    expect(snap?.status).toBe('done')
    q.dispose()
  })

  it('merges similar goals in short window', async () => {
    const goals = []
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async (input) => {
        goals.push(input.goal)
        await new Promise((r) => setTimeout(r, 20))
      },
    })
    const p1 = q.enqueue({ agentCode: 'x', roleName: 'X', goal: '改报告', depth: 0 })
    const p2 = q.enqueue({ agentCode: 'x', roleName: 'X', goal: '改报告', depth: 0 })
    await Promise.all([p1, p2])
    expect(goals).toEqual(['改报告'])
    q.dispose()
  })

  it('skips duplicate nest chainKey within same turn', async () => {
    const runs = []
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async (input) => {
        runs.push(input.agentCode)
      },
    })
    await q.enqueue({
      agentCode: 'b',
      roleName: 'B',
      goal: 'hi',
      depth: 1,
      chainKey: 'user1|a->b',
    })
    await q.enqueue({
      agentCode: 'b',
      roleName: 'B',
      goal: 'hi again',
      depth: 1,
      chainKey: 'user1|a->b',
    })
    expect(runs).toEqual(['b'])
    q.dispose()
  })

  it('allows same nest chain again after a new depth-0 user turn', async () => {
    const runs = []
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async (input) => {
        runs.push(`${input.depth}:${input.agentCode}:${input.goal}`)
      },
    })
    await q.enqueue({
      agentCode: 'tech-director',
      roleName: '技术总监',
      goal: 'first',
      depth: 1,
      chainKey: 'xiaomi->tech-director',
    })
    // 用户新一轮发言（depth=0）应清 nestSeen，允许小V 再次 @ 技术总监
    await q.enqueue({
      agentCode: 'xiaomi',
      roleName: '小V',
      goal: 'steward turn',
      depth: 0,
    })
    await q.enqueue({
      agentCode: 'tech-director',
      roleName: '技术总监',
      goal: 'second',
      depth: 1,
      chainKey: 'xiaomi->tech-director',
    })
    expect(runs).toEqual([
      '1:tech-director:first',
      '0:xiaomi:steward turn',
      '1:tech-director:second',
    ])
    q.dispose()
  })

  it('fails after max busy attempts', async () => {
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async () => ({ busy: true, error: 'busy' }),
    })
    await expect(
      q.enqueue({ agentCode: 'x', roleName: 'X', goal: 'hi', depth: 0 }),
    ).rejects.toThrow(/忙/)
    const snap = q.snapshot().find((j) => j.agentCode === 'x')
    expect(snap?.status).toBe('failed')
    expect(snap?.attempts).toBe(4)
    q.dispose()
  })

  it('dispose mid-run with salvaged reply resolves instead of 已取消', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async () => {
        await gate
        return {}
      },
    })
    const p = q.enqueue({ agentCode: 'x', roleName: 'X', goal: 'hi', depth: 0 })
    await new Promise((r) => setTimeout(r, 10))
    q.dispose()
    release()
    await expect(p).resolves.toBeUndefined()
    const snap = q.snapshot().find((j) => j.agentCode === 'x')
    expect(snap?.status).toBe('done')
  })

  it('dispose cancels only queued jobs, not the running salvage path', async () => {
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const started = []
    const q = new DeptGroupWakeQueue({
      sleep: async () => {},
      run: async (input) => {
        started.push(input.goal)
        await gate
        return {}
      },
    })
    const p1 = q.enqueue({ agentCode: 'x', roleName: 'X', goal: 'first', depth: 0 })
    const p2 = q.enqueue({ agentCode: 'x', roleName: 'X', goal: 'second', depth: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toEqual(['first'])
    q.dispose()
    await expect(p2).rejects.toThrow(/已取消/)
    release()
    await expect(p1).resolves.toBeUndefined()
  })
})
