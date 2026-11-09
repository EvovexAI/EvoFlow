/**
 * 「点开会话 → 上屏」分段计时：阈值判定 + 归因 + 中断处理。
 *
 * 这是排查「点开有时秒开、有时等几秒」的断言层：
 * 快的那次不该报 warn/error；慢的那次必须报出来并说清慢在哪、为什么。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  __resetOpenTraceForTest,
  beginOpenTrace,
  bindOpenTraceThread,
  endOpenTrace,
  getOpenTraceRing,
  isOpenTraceActive,
  markOpenStage,
} from '../src/zcode-ui/lib/openTrace.ts'

describe('openTrace 分段计时', () => {
  beforeEach(() => {
    __resetOpenTraceForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('点击即建立锚点，后续阶段带累计耗时', () => {
    beginOpenTrace('agent:main:abc')
    expect(isOpenTraceActive()).toBe(true)

    vi.advanceTimersByTime(120)
    markOpenStage('acquire', '租约挂上', { openKind: 'cold' })

    const rec = getOpenTraceRing()[0]
    const acquire = rec.stages.find((s) => s.stage === 'acquire')
    expect(acquire).toBeTruthy()
    expect(acquire!.durationMs).toBe(120)
    expect(acquire!.atMs).toBe(120)
    // 120ms 在默认阈值内 → 不该报 warn。
    expect(acquire!.status).toBe('ok')
    expect(acquire!.reason).toBeUndefined()
  })

  it('超阈值打 warn 并给出归因（说明慢在哪、为什么）', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(1500)
    markOpenStage('subscribe', '订阅返回', { subscribeHttpMs: 1500, hydrateMs: 1400 })

    const acquire = getOpenTraceRing()[0].stages.find((s) => s.stage === 'subscribe')
    expect(acquire!.status).toBe('warn')
    expect(acquire!.reason).toContain('hydrate')
  })

  it('超过 error 阈值升级为 error', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(3500)
    markOpenStage('subscribe', '订阅返回', { subscribeHttpMs: 3500 })

    const sub = getOpenTraceRing()[0].stages.find((s) => s.stage === 'subscribe')
    expect(sub!.status).toBe('error')
  })

  it('显式 reason 覆盖默认归因文案', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(2000)
    markOpenStage('ensure_thread', 'ensure 失败', {}, { reason: '服务端 500' })

    const st = getOpenTraceRing()[0].stages.find((s) => s.stage === 'ensure_thread')
    expect(st!.reason).toBe('服务端 500')
    expect(st!.status).toBe('warn')
  })

  it('总耗时超阈值时结束 trace 并标 warn/error', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(1500)
    markOpenStage('acquire', '租约挂上')
    endOpenTrace()

    const rec = getOpenTraceRing()[0]
    expect(rec.status).toBe('warn')
    expect(rec.totalMs).toBe(1500)
    expect(rec.verdict).toContain('1500ms')
    expect(isOpenTraceActive()).toBe(false)
  })

  it('总耗时在阈值内 → status=ok', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(300)
    markOpenStage('acquire', '租约挂上')
    endOpenTrace()

    const rec = getOpenTraceRing()[0]
    expect(rec.status).toBe('ok')
    expect(rec.totalMs).toBe(300)
  })

  it('记录最慢的一段，便于和快的那次对比', () => {
    beginOpenTrace('agent:main:abc')
    vi.advanceTimersByTime(50)
    markOpenStage('acquire', '租约挂上')
    vi.advanceTimersByTime(900)
    markOpenStage('subscribe', '订阅返回')
    vi.advanceTimersByTime(20)
    markOpenStage('frame_snapshot', '首帧到了')
    endOpenTrace()

    const rec = getOpenTraceRing()[0]
    expect(rec.slowest?.stage).toBe('subscribe')
    expect(rec.slowest?.durationMs).toBe(900)
  })

  it('新的点击会打断上一次并把它归档（不留悬挂 trace）', () => {
    beginOpenTrace('agent:main:first')
    vi.advanceTimersByTime(100)
    beginOpenTrace('agent:main:second')

    const ring = getOpenTraceRing()
    expect(ring.length).toBe(2)
    expect(ring[0].sessionKey).toBe('agent:main:first')
    expect(ring[0].status).toBe('warn')
    expect(ring[0].verdict).toContain('打断')
    expect(ring[1].sessionKey).toBe('agent:main:second')
  })

  it('bindOpenTraceThread 把 threadId 写进后续记录', () => {
    beginOpenTrace('agent:main:abc')
    bindOpenTraceThread('thread-xyz')
    markOpenStage('acquire', '租约挂上')
    endOpenTrace()

    expect(getOpenTraceRing()[0].threadId).toBe('thread-xyz')
  })

  it('trace 结束后 markOpenStage 不再写入（防止串到下一次打开）', () => {
    beginOpenTrace('agent:main:abc')
    endOpenTrace()
    const before = getOpenTraceRing()[0].stages.length
    markOpenStage('acquire', '不该被记录')
    expect(getOpenTraceRing()[0].stages.length).toBe(before)
  })
})
