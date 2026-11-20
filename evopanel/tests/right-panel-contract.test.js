import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  __resetRightPanelContractCache,
  describeMissingFields,
  findKindSpec,
  missingContractFields,
  normalizeRightPanelContract,
} from '../src/lib/right-stage/right-panel-contract.ts'

/**
 * 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：为右栏契约模块补前端测试。
 * 为什么：这份模块替掉了 open-progress-from-panel-set.ts 里原先硬编码的
 * 必填校验；如果它自己错，前端就会和刚统一好的后端口径再次分叉。
 * 测的都是「和后端 right_panel_kinds.py 同口径」的具体断言。
 */

beforeEach(() => {
  __resetRightPanelContractCache()
})

describe('normalizeRightPanelContract', () => {
  it('拒绝非 ok 或没有 kinds 的载荷', () => {
    expect(normalizeRightPanelContract(null)).toBeNull()
    expect(normalizeRightPanelContract({})).toBeNull()
    expect(normalizeRightPanelContract({ ok: false, kinds: [] })).toBeNull()
    expect(normalizeRightPanelContract({ ok: true, kinds: [] })).toBeNull()
    expect(normalizeRightPanelContract({ ok: true })).toBeNull()
  })

  it('接受后端真实载荷并保留必填字段', () => {
    const out = normalizeRightPanelContract({
      ok: true,
      kinds: [
        {
          kind: 'employeeProcess',
          label: '员工执行过程',
          trigger: 'agent',
          layout: 'wide',
          required: ['data.agentCode'],
        },
        {
          kind: 'collabSubtaskTranscript',
          required: ['data.mainTaskId', 'data.subtaskId'],
        },
      ],
      autoOpenActions: ['employees.wake'],
      readOnlyActions: ['tasks.list'],
    })
    expect(out).not.toBeNull()
    expect(out.kinds.map((k) => k.kind)).toEqual([
      'employeeProcess',
      'collabSubtaskTranscript',
    ])
    // 缺 label 时用 kind 兜底，不能出现 undefined 标题
    expect(out.kinds[1].label).toBe('collabSubtaskTranscript')
    expect(out.readOnlyActions).toContain('tasks.list')
  })
})

describe('缺失字段校验与后端口径一致', () => {
  it('employeeProcess 只要求 agentCode，taskId 可缺（第87轮修的对不齐）', () => {
    // 未加载契约时用内置兜底表，同样只要求 agentCode
    expect(findKindSpec('employeeProcess')).not.toBeNull()
    expect(missingContractFields('employeeProcess', { agentCode: 'duty-ops' })).toEqual([])
    expect(missingContractFields('employeeProcess', {})).toEqual(['agentCode'])
  })

  it('collabSubtaskTranscript 两个 id 都必需', () => {
    expect(missingContractFields('collabSubtaskTranscript', { mainTaskId: 'm' })).toEqual([
      'subtaskId',
    ])
    expect(
      missingContractFields('collabSubtaskTranscript', { mainTaskId: 'm', subtaskId: 's' }),
    ).toEqual([])
  })

  it('空白字符串算缺失（不能拿 "  " 当有值）', () => {
    expect(missingContractFields('web-embed', { url: '   ' })).toEqual(['url'])
    expect(missingContractFields('web-embed', { url: 'https://a.b' })).toEqual([])
  })

  it('未知 kind 不报缺失（交给渲染层兜底提示）', () => {
    expect(missingContractFields('some-future-kind', {})).toEqual([])
  })
})

describe('给用户的提示文案', () => {
  it('有具体缺失字段时点名缺什么', () => {
    const text = describeMissingFields('collabSubtaskTranscript', ['subtaskId'])
    expect(text).toContain('协作节点进度')
    expect(text).toContain('subtaskId')
  })

  it('没有缺失字段时不说「缺 」，避免怪异文案', () => {
    const text = describeMissingFields('employeeProcess', [])
    expect(text).toContain('员工执行过程')
    expect(text).not.toContain('缺少')
  })

  it('未知 kind 用 kind 名兜底，不出现 undefined', () => {
    const text = describeMissingFields('mystery-kind', ['x'])
    expect(text).toContain('mystery-kind')
    expect(text).not.toContain('undefined')
  })
})

/**
 * 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增「契约预取真的发出请求、且 URL 只带一个 /api」的接线测试。
 * 为什么：用户当面点破「你验证好前端和后端吗」。此前我只测了纯函数，
 * 没测模块加载副作用——而真实的 bug 就藏在那儿：
 *   ① 预取原先写在 lib/right-stage/index.ts，但全仓没有生产代码 import 那个
 *      barrel，loadRightPanelContract() 一次都不执行，缓存恒 null；
 *   ② 请求路径写成 '/api/stage/...'，而 apiUrlAsync 自己会拼 `${base}/api`，
 *      实测得到 '/api/api/stage/right-stage/kinds' → 404 → 永远走兜底表。
 * 两条都会让「前端读后端契约」在生产里静默失效，且纯函数测试全绿。
 * 本测试用 fetch 探针锁住「路径正确」和「预取确实被触发」。
 */
describe('契约预取接线', () => {
  it('非测试模式下模块加载即预取，且 URL 只带一个 /api', async () => {
    const calls = []
    const g = globalThis
    const origFetch = g.fetch
    const origMode = import.meta.env.MODE
    g.fetch = async (u) => {
      calls.push(String(u))
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      import.meta.env.MODE = 'production'
      vi.resetModules()
      await import('../src/lib/right-stage/right-panel-contract.ts')
      await new Promise((r) => setTimeout(r, 80))
    } finally {
      g.fetch = origFetch
      import.meta.env.MODE = origMode
      vi.resetModules()
    }
    const hits = calls.filter((u) => u.includes('right-stage/kinds'))
    // 预取必须真的发生（否则 index.ts 那种「写了但没人加载」的死代码会复现）
    expect(hits.length).toBeGreaterThan(0)
    // 且路径不能出现 /api/api（apiUrlAsync 已自带一层 /api）
    expect(hits.some((u) => u.includes('/api/api/'))).toBe(false)
    expect(hits[0]).toContain('/api/stage/right-stage/kinds')
  })

  it('测试模式下不预取（避免单测打网络）', async () => {
    const calls = []
    const g = globalThis
    const origFetch = g.fetch
    g.fetch = async (u) => {
      calls.push(String(u))
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      vi.resetModules()
      await import('../src/lib/right-stage/right-panel-contract.ts')
      await new Promise((r) => setTimeout(r, 60))
    } finally {
      g.fetch = origFetch
      vi.resetModules()
    }
    expect(calls.filter((u) => u.includes('right-stage/kinds'))).toEqual([])
  })
})
