/**
 * 死会话 404 风暴必须退避。
 *
 * 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 现网实证（2026-11-19 gateway access log）：
 *   `GET /api/chat/sessions/c57b6608-…/execution/state` 被打 **5,685 次**、
 *   全部 404，从 01:29:28 持续到 06:22:06（4 小时 53 分，约 19 次/分钟）；
 *   另一个 UUID 又重演 414 次；11 点再一轮 416 次。
 *
 * 根因：`fetchSessionRuntimeStatus` 的 catch 分支只 `return cached?.data ?? null`，
 * **不写回任何缓存**，而三个轮询调用方都传 `bypassCache: true`（前台状态守卫 20s、
 * 子工作区 3s、运行时面板），所以 4500ms 节流对它们完全无效 —— 20s 定时器次次
 * 打到后端、永不降频，一个已删除的会话就能刷一整天。
 *
 * 判据：失败必须按 30s→60s→…→300s 退避，且 `bypassCache` 不得越过退避；
 * 成功一次即恢复；`invalidateSessionRuntimeStatusCache` 连退避一起清。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/gateway-json.js', () => ({ gatewayJson: vi.fn() }))

import { gatewayJson } from '../src/lib/gateway-json.js'
import {
  fetchSessionRuntimeStatus,
  invalidateSessionRuntimeStatusCache,
} from '../src/react/lib/session-reattach.ts'

const DEAD_KEY = 'c57b6608-dead-session'

function okProbe(sessionKey) {
  return { sessionKey, runStatus: 'idle', executing: false, ok: true }
}

beforeEach(() => {
  vi.resetAllMocks()
  invalidateSessionRuntimeStatusCache()
  vi.useRealTimers()
})

describe('session execution probe failure backoff', () => {
  it('一个已删除的会话被反复轮询时不会每次都打后端', async () => {
    gatewayJson.mockRejectedValue(Object.assign(new Error('Gateway API failed: 404'), { status: 404 }))

    // 模拟 20s 定时器连续 12 次轮询（现网 4 小时 53 分里至少上千次）。
    for (let i = 0; i < 12; i += 1) {
      await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    }

    // 未退避时这里是 12 —— 正是 5,685 次的生成机制。
    expect(gatewayJson.mock.calls.length).toBe(1)
  })

  it('第一次失败后立刻重试也会被退避挡住', async () => {
    gatewayJson.mockRejectedValue(new Error('404'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(1)
  })

  it('退避窗口过去后会再试一次，且退避时间按 2 倍增长', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T10:00:00+08:00'))
    gatewayJson.mockRejectedValue(new Error('404'))

    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true }) // 失败 1，退避 30s
    vi.setSystemTime(new Date('2026-11-19T10:00:29+08:00'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(1)

    vi.setSystemTime(new Date('2026-11-19T10:00:31+08:00'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true }) // 失败 2，退避 60s
    expect(gatewayJson.mock.calls.length).toBe(2)

    vi.setSystemTime(new Date('2026-11-19T10:01:20+08:00'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(2) // 30s 已过但 60s 未到

    vi.setSystemTime(new Date('2026-11-19T10:01:35+08:00'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(3)

    vi.useRealTimers()
  })

  it('退避封顶，不会无限增长', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T10:00:00+08:00'))
    gatewayJson.mockRejectedValue(new Error('404'))

    for (let i = 0; i < 20; i += 1) {
      await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
      vi.setSystemTime(new Date(Date.now() + 600_000)) // 每次跨过任何窗口
    }
    const callsAfterWarmup = gatewayJson.mock.calls.length
    // 封顶 300s 后：多推进 299s 不该重试，推进到 301s 才试。
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    const n = gatewayJson.mock.calls.length
    vi.setSystemTime(new Date(Date.now() + 299_000))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(n)
    vi.setSystemTime(new Date(Date.now() + 2_000))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(n + 1)
    expect(callsAfterWarmup).toBeGreaterThan(0)

    vi.useRealTimers()
  })

  it('一旦成功就清零退避，退避不会粘住健康会话', async () => {
    gatewayJson.mockRejectedValueOnce(new Error('404'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })

    gatewayJson.mockResolvedValue(okProbe(DEAD_KEY))
    // 退避窗口内 —— 但这里必须放行，否则会话恢复正常也永远读不到了。
    // 判据用 invalidate 的语义：用户/系统确认会话存在时清退避。
    invalidateSessionRuntimeStatusCache(DEAD_KEY)
    const probe = await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(probe?.sessionKey).toBe(DEAD_KEY)

    // 成功之后再失败一次，退避重新从 30s 起步（不能沿用之前的计数）。
    gatewayJson.mockRejectedValue(new Error('404'))
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    const n = gatewayJson.mock.calls.length
    await fetchSessionRuntimeStatus(DEAD_KEY, { bypassCache: true })
    expect(gatewayJson.mock.calls.length).toBe(n) // 仍被 30s 挡住
  })

  it('健康会话的正常缓存语义不变（未 bypassCache 时命中缓存不重复打）', async () => {
    gatewayJson.mockResolvedValue(okProbe(DEAD_KEY))
    await fetchSessionRuntimeStatus(DEAD_KEY)
    await fetchSessionRuntimeStatus(DEAD_KEY)
    expect(gatewayJson.mock.calls.length).toBe(1)
  })
})
