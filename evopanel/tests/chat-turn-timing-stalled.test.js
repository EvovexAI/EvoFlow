/**
 * 卡住重发：Composer 先 send_click 会顶掉 sendTrace，必须还能认出上一轮无首帧。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('describeStalledPriorSend', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T01:00:00.000Z'))
  })

  it('survives a second send_click that replaces sendTrace', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnSendClick({
      sessionKey: 'proactive:manju-director:chat:x',
      text: '这里需要调用MiniMax，调用几次呀',
    })
    mod.logChatTurnSendWire({ sessionKey: 'proactive:manju-director:chat:x' })
    vi.setSystemTime(new Date('2026-11-11T01:00:20.000Z'))
    // Composer 第二次点击：会 archive 上一轮
    mod.logChatTurnSendClick({
      sessionKey: 'proactive:manju-director:chat:x',
      text: '继续',
    })
    const stalled = mod.describeStalledPriorSend('proactive:manju-director:chat:x')
    expect(stalled.stalled).toBe(true)
    expect(stalled.sinceMs).toBeGreaterThanOrEqual(20_000)
    expect(stalled.textPreview).toContain('MiniMax')
    expect(stalled.wireLogged).toBe(true)
  })

  it('clears unanswered prior after first_response', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnSendClick({ sessionKey: 's1', text: 'hi' })
    mod.logChatTurnSendWire({ sessionKey: 's1' })
    vi.setSystemTime(new Date('2026-11-11T01:00:12.000Z'))
    mod.logChatTurnFirstResponse({ sessionKey: 's1', kind: 'text', preview: 'ok' })
    mod.logChatTurnSendClick({ sessionKey: 's1', text: 'again' })
    expect(mod.describeStalledPriorSend('s1').stalled).toBe(false)
  })

  it('stream_end closes the turn lifecycle once', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    mod.logChatTurnSendClick({ sessionKey: 's2', text: '哈喽' })
    mod.logChatTurnRunStarted({ sessionKey: 's2', runId: 'run-1' })
    vi.setSystemTime(new Date('2026-11-11T01:00:05.000Z'))
    mod.logChatTurnFirstResponse({ sessionKey: 's2', kind: 'reasoning', preview: 'hi' })
    vi.setSystemTime(new Date('2026-11-11T01:00:40.000Z'))
    mod.logChatTurnStreamEnd({
      sessionKey: 's2',
      runId: 'run-1',
      outcome: 'sse_aborted',
      whoZh: '异常断流',
      trigger: 'sse_aborted',
      hasEndMarker: false,
    })
    // 第二次应被忽略（trace 已清）
    mod.logChatTurnStreamEnd({
      sessionKey: 's2',
      runId: 'run-1',
      outcome: 'sse_final',
      trigger: 'sse_final',
      hasEndMarker: true,
    })
    expect(mod.chatTurnSinceSendMs('s2')).toBeNull()
  })
})

/**
 * 【self-evolution-bot · 2026-11-27 · 第137轮 · 模型:deepseek-v4-1-flash-261017】
 * 为什么加这条：2026-11-27 全天 40 条 send_click 里只有 3 条带 sessionKey ——
 * 因为 ChatComposer 的两个调用点漏传。漏传时统计脚本只能靠「atMs + sinceSendMs」时序反推，
 * 跨日志轮转的那一轮会配错，于是「发出去有没有收口」这个核心指标不可信。
 * 断言的是**接线**：日志输出里必须真的出现 sessionKey 字段，而不是只在函数签名里支持。
 */
describe('send_click 必须带 sessionKey（统计判据的可信前提）', () => {
  it('传了就写进输出，配对不再靠时序猜', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T04:00:00.000Z'))
    const lines = []
    const orig = console.info
    console.info = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    try {
      const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
      mod.logChatTurnSendClick({ sessionKey: 'agent:main:new-abc', text: 'hi' })
    } finally {
      console.info = orig
    }
    const hit = lines.find((l) => l.includes('send_click'))
    expect(hit).toBeTruthy()
    // 铁证：字段必须出现在落盘文本里
    expect(hit).toContain('"sessionKey":"agent:main:new-abc"')
  })

  it('反证：不传就没有该字段（说明这条断言真的能抓到漏传）', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T04:00:01.000Z'))
    const lines = []
    const orig = console.info
    console.info = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    try {
      const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
      mod.logChatTurnSendClick({ text: 'no session' })
    } finally {
      console.info = orig
    }
    const hit = lines.find((l) => l.includes('send_click'))
    expect(hit).toBeTruthy()
    expect(hit).not.toContain('"sessionKey":"agent:main')
  })
})
