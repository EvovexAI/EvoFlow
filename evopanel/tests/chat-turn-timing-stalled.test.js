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
})
