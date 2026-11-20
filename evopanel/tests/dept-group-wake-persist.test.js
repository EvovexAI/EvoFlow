/**
 * 部门群叫醒队列「旁路持久化」测试。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 判据重点不是「能调用」，而是**失败必须沉默**：
 * 旁路一旦把异常抛回群聊主流程，就等于用一个可选功能拖垮核心功能。
 * 反过来，成功路径要能被验证到真的发出去了（不能只看返回 true）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DeptGroupWakePersist,
  shouldRetryWakePersist,
} from '../src/react/lib/dept-group-wake-persist.ts'

function mkTransport() {
  const posts = []
  const gets = []
  return {
    posts,
    gets,
    transport: {
      post: async (path, body) => {
        posts.push({ path, body })
        return { ok: true }
      },
      get: async (path, query) => {
        gets.push({ path, query })
        return { jobs: [] }
      },
    },
  }
}

describe('DeptGroupWakePersist · 入队旁路', () => {
  it('把入队事实发到正确端点，字段名与后端一致（snake_case）', async () => {
    const t = mkTransport()
    const p = new DeptGroupWakePersist({ transport: t.transport })
    const ok = await p.recordEnqueue({
      jobId: 'wake-a-1-1000',
      deptId: 'd1',
      agentCode: 'a',
      roleName: '甲',
      goal: '看下报表',
      depth: 0,
    })
    expect(ok).toBe(true)
    expect(t.posts).toHaveLength(1)
    expect(t.posts[0].path).toBe('/api/dept-groups/wake-jobs/enqueue')
    const b = t.posts[0].body
    // 后端 pydantic 是 snake_case，写错名会被忽略/422
    expect(b.job_id).toBe('wake-a-1-1000')
    expect(b.dept_id).toBe('d1')
    expect(b.agent_code).toBe('a')
    expect(b.role_name).toBe('甲')
  })

  it('同一 jobId 只发一次（幂等，避免重复打后端）', async () => {
    const t = mkTransport()
    const p = new DeptGroupWakePersist({ transport: t.transport })
    await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' })
    await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' })
    expect(t.posts).toHaveLength(1)
  })

  it('缺 jobId 或 agentCode 时不发请求', async () => {
    const t = mkTransport()
    const p = new DeptGroupWakePersist({ transport: t.transport })
    expect(await p.recordEnqueue({ jobId: '', deptId: 'd1', agentCode: 'a' })).toBe(false)
    expect(await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: '' })).toBe(false)
    expect(t.posts).toHaveLength(0)
  })
})

describe('DeptGroupWakePersist · 失败必须沉默（不拖垮群聊）', () => {
  it('后端 500 时返回 false 且不抛异常', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => {
          throw new Error('boom')
        },
        get: async () => {
          throw new Error('boom')
        },
      },
    })
    await expect(
      p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' }),
    ).resolves.toBe(false)
    await expect(p.recordStatus({ jobId: 'j1', status: 'done' })).resolves.toBe(false)
    await expect(p.heartbeat('j1')).resolves.toBe(false)
    await expect(p.loadPending('d1')).resolves.toEqual([])
  })

  it('后端 404（未升级到该路由）时 loadPending 返回空数组而不是崩', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => ({ ok: true }),
        get: async () => {
          const e = new Error('not found')
          e.status = 404
          throw e
        },
      },
    })
    expect(await p.loadPending('d1')).toEqual([])
  })

  it('onError 会收到定位信息（便于排障，但不外抛）', async () => {
    const seen = []
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => {
          throw new Error('boom')
        },
        get: async () => ({ jobs: [] }),
      },
      onError: (where) => seen.push(where),
    })
    await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' })
    expect(seen).toEqual(['enqueue'])
  })

  it('onError 自己抛异常也不能冒泡出去', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => {
          throw new Error('boom')
        },
        get: async () => ({ jobs: [] }),
      },
      onError: () => {
        throw new Error('handler boom')
      },
    })
    await expect(
      p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' }),
    ).resolves.toBe(false)
  })
})

describe('DeptGroupWakePersist · 恢复队列', () => {
  it('把后端行映射成前端可用的恢复结构', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => ({ ok: true }),
        get: async () => ({
          jobs: [
            {
              job_id: 'wake-a-1-1000',
              dept_id: 'd1',
              agent_code: 'a',
              role_name: '甲',
              goal: '看下报表',
              depth: 1,
              chain_key: 'chain-1',
              steward_mode: 1,
              source_msg_id: 'm-9',
              status: 'queued',
              attempts: 2,
              error: '',
              enqueued_at: '2026-11-20T09:00:00+08:00',
            },
          ],
        }),
      },
    })
    const jobs = await p.loadPending('d1')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].job_id).toBe('wake-a-1-1000')
    expect(jobs[0].steward_mode).toBe(true)
    // depth/chain_key 必须带回来，否则恢复后防环失效
    expect(jobs[0].depth).toBe(1)
    expect(jobs[0].chain_key).toBe('chain-1')
  })

  it('过滤掉缺 job_id / agent_code 的脏行', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => ({ ok: true }),
        get: async () => ({
          jobs: [{ job_id: '', agent_code: 'a' }, { job_id: 'j2' }, null, 'junk'],
        }),
      },
    })
    expect(await p.loadPending('d1')).toEqual([])
  })
})

describe('DeptGroupWakePersist · 开关与重试判据', () => {
  it('enabled=false 时一个请求都不发', async () => {
    const t = mkTransport()
    const p = new DeptGroupWakePersist({ transport: t.transport, enabled: false })
    await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' })
    await p.recordStatus({ jobId: 'j1', status: 'done' })
    await p.loadPending('d1')
    expect(t.posts).toHaveLength(0)
    expect(t.gets).toHaveLength(0)
  })

  it('401/403/404 不重试（路由不存在，重试无意义）', () => {
    expect(shouldRetryWakePersist({ status: 404 })).toBe(false)
    expect(shouldRetryWakePersist({ status: 401 })).toBe(false)
    expect(shouldRetryWakePersist({ status: 403 })).toBe(false)
    expect(shouldRetryWakePersist({ status: 500 })).toBe(true)
    expect(shouldRetryWakePersist(new Error('network'))).toBe(true)
  })

  it('syncSnapshot 只同步终态，且只同步已落过库的任务', async () => {
    const t = mkTransport()
    const p = new DeptGroupWakePersist({ transport: t.transport })
    // 未 recordEnqueue 的任务不应被同步（避免给后端塞临时 id）
    await p.syncSnapshot([{ id: 'unknown', status: 'done' }])
    expect(t.posts).toHaveLength(0)

    await p.recordEnqueue({ jobId: 'j1', deptId: 'd1', agentCode: 'a' })
    t.posts.length = 0
    await p.syncSnapshot([
      { id: 'j1', status: 'running' },
      { id: 'j1', status: 'done' },
    ])
    expect(t.posts).toHaveLength(1)
    expect(t.posts[0].body.status).toBe('done')
  })
})

describe('DeptGroupWakePersist · claim（恢复必须认领）', () => {
  it('认领成功时把后端行映射成可重排结构，并记为已落库', async () => {
    const posts = []
    const p = new DeptGroupWakePersist({
      transport: {
        post: async (path, body) => {
          posts.push({ path, body })
          return {
            ok: true,
            job: {
              job_id: 'wake-a-1-1000',
              dept_id: 'd1',
              agent_code: 'a',
              role_name: '甲',
              goal: '看下报表',
              depth: 2,
              chain_key: 'chain-x',
              steward_mode: 0,
              source_msg_id: 'm-1',
              status: 'running',
              attempts: 1,
            },
          }
        },
        get: async () => ({ jobs: [] }),
      },
    })
    const job = await p.claim('d1', 'a', 'evopanel')
    expect(job).not.toBeNull()
    expect(job.job_id).toBe('wake-a-1-1000')
    expect(job.depth).toBe(2)
    expect(job.chain_key).toBe('chain-x')
    expect(job.status).toBe('running')
    expect(posts[0].path).toBe('/api/dept-groups/wake-jobs/claim')
  })

  it('job=null（别人正在跑）时返回 null，不报错', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => ({ ok: true, job: null }),
        get: async () => ({ jobs: [] }),
      },
    })
    expect(await p.claim('d1', 'a')).toBeNull()
  })

  it('claim 失败时返回 null（不抛），恢复流程不会被拖垮', async () => {
    const p = new DeptGroupWakePersist({
      transport: {
        post: async () => {
          throw new Error('network down')
        },
        get: async () => ({ jobs: [] }),
      },
    })
    await expect(p.claim('d1', 'a')).resolves.toBeNull()
  })

  it('缺 agent_code 时不发请求', async () => {
    const posts = []
    const p = new DeptGroupWakePersist({
      transport: {
        post: async (path, body) => {
          posts.push({ path, body })
          return { ok: true, job: null }
        },
        get: async () => ({ jobs: [] }),
      },
    })
    expect(await p.claim('d1', '')).toBeNull()
    expect(posts).toHaveLength(0)
  })
})
