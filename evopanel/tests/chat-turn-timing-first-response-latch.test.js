/**
 * 首帧响应幂等闩：后台/主动任务回合没有本窗 sendTrace，旧守卫全旁路 →
 * 每个 TEXT/REASONING delta 都会 emit（console + 双 IPC 落盘），2026-11-14 实测
 * 单日 11,750 条、峰值 57 条/s，流式全程给主线程叠税。按 session|run 只放行首个 chunk。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('logChatTurnFirstResponse per-turn latch', () => {
  let infoSpy
  let warnSpy

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-14T09:00:00.000Z'))
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // 距发送 ≥ SLOW_FIRST_MS(3s) 的首帧走 console.warn，其余走 console.info
  const firstResponseEmits = () =>
    [...infoSpy.mock.calls, ...warnSpy.mock.calls].filter(
      (c) => c[1]?.event === 'first_response',
    ).length

  it('background turn without sendTrace: 50 deltas log exactly once', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    for (let i = 0; i < 50; i++) {
      mod.logChatTurnFirstResponse({
        sessionKey: 'proactive:aigc-remaker:chat:x',
        kind: 'text',
        preview: `字${i}`,
      })
    }
    expect(firstResponseEmits()).toBe(1)
  })

  it('same turn with mixed runId presence stays latched', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnFirstResponse({ sessionKey: 's1', kind: 'text', preview: 'a', runId: 'run-a' })
    // runId 忽然缺失 / 回来 / 换 kind：都还是同一回合，不得再放行
    mod.logChatTurnFirstResponse({ sessionKey: 's1', kind: 'text', preview: 'b' })
    mod.logChatTurnFirstResponse({ sessionKey: 's1', kind: 'reasoning', preview: 'c', runId: 'run-a' })
    mod.logChatTurnFirstResponse({ sessionKey: 's1', kind: 'tool', preview: '工具 grep' })
    expect(firstResponseEmits()).toBe(1)
  })

  it('different sessions latch independently', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnFirstResponse({ sessionKey: 'sA', kind: 'text', preview: 'a' })
    mod.logChatTurnFirstResponse({ sessionKey: 'sB', kind: 'text', preview: 'b' })
    mod.logChatTurnFirstResponse({ sessionKey: 'sA', kind: 'text', preview: 'a2' })
    expect(firstResponseEmits()).toBe(2)
  })

  it('RUN_STARTED clears the latch so the next turn logs its first chunk', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnFirstResponse({ sessionKey: 's2', kind: 'text', preview: 'turn1' })
    // 后台回合 sendTrace 为 null：清闩逻辑必须在 sendTrace 守卫之前生效
    mod.logChatTurnRunStarted({ sessionKey: 's2', runId: 'run-2' })
    mod.logChatTurnFirstResponse({ sessionKey: 's2', kind: 'text', preview: 'turn2' })
    expect(firstResponseEmits()).toBe(2)
  })

  it('latch expires after TTL', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnFirstResponse({ sessionKey: 's3', kind: 'text', preview: 'x' })
    vi.setSystemTime(new Date('2026-11-14T09:11:00.000Z'))
    mod.logChatTurnFirstResponse({ sessionKey: 's3', kind: 'text', preview: 'y' })
    expect(firstResponseEmits()).toBe(2)
  })

  it('sendTrace-anchored turn still records sinceSendMs once', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnSendClick({ sessionKey: 's4', text: 'hi' })
    mod.logChatTurnSendWire({ sessionKey: 's4' })
    vi.setSystemTime(new Date('2026-11-14T09:00:03.000Z'))
    mod.logChatTurnFirstResponse({ sessionKey: 's4', kind: 'text', preview: 'ok' })
    mod.logChatTurnFirstResponse({ sessionKey: 's4', kind: 'text', preview: 'ok2' })
    const calls = [...infoSpy.mock.calls, ...warnSpy.mock.calls].filter(
      (c) => c[1]?.event === 'first_response',
    )
    expect(calls.length).toBe(1)
    expect(calls[0][1].sinceSendMs).toBe(3000)
  })
})
