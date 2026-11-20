/**
 * 发送水位线：正常收口摘要 + 异常展开卡点/接口；正常环收紧。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('chat turn waterline', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T01:00:00.000Z'))
  })

  it('marks normal sse_final as ok and keeps abnormal with api hints', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')

    mod.logChatTurnSendClick({ sessionKey: 'sk-ok', text: '正常一句' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: 'sk-ok' })
    mod.logChatTurnSendWire({ sessionKey: 'sk-ok' })
    mod.logChatTurnRunStarted({ sessionKey: 'sk-ok', runId: 'r-ok' })
    vi.setSystemTime(new Date('2026-11-20T01:00:00.800Z'))
    mod.logChatTurnFirstResponse({
      sessionKey: 'sk-ok',
      kind: 'text',
      preview: '好的',
      runId: 'r-ok',
    })
    vi.setSystemTime(new Date('2026-11-20T01:00:02.000Z'))
    mod.logChatTurnStreamEnd({
      sessionKey: 'sk-ok',
      runId: 'r-ok',
      outcome: 'sse_final',
      trigger: 'sse_final',
      hasEndMarker: true,
    })

    vi.setSystemTime(new Date('2026-11-20T01:01:00.000Z'))
    mod.logChatTurnSendClick({ sessionKey: 'sk-ok', text: '卡住这句' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: 'sk-ok' })
    // 不上线，等 6s → 未上线
    vi.setSystemTime(new Date('2026-11-20T01:01:06.000Z'))

    const rows = mod.listChatTurnTimingRows({ sessionKey: 'sk-ok' })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const okRow = rows.find((r) => r.textPreview.includes('正常'))
    const badRow = rows.find((r) => r.textPreview.includes('卡住'))
    expect(mod.classifyChatTurnTimingVerdict(okRow).level).toBe('ok')
    expect(mod.classifyChatTurnTimingVerdict(badRow).level).toBe('error')
    expect(mod.classifyChatTurnTimingVerdict(badRow).zh).toContain('未上线')

    const lines = mod.formatChatTurnWaterlineForDiag({
      sessionKey: 'sk-ok',
      apiHints: [
        {
          at: Date.parse('2026-11-20T01:01:01.000Z'),
          path: '/api/subscribe',
          ok: false,
          ms: 12005,
          status: 0,
          error: 'timeout',
        },
      ],
    })
    const blob = lines.join('\n')
    expect(blob).toContain('发送水位线')
    expect(blob).toMatch(/本会话 \d+ 发/)
    expect(blob).toContain('[正常]')
    expect(blob).toContain('异常·未上线')
    expect(blob).toContain('前后接口')
    expect(blob).toContain('subscribe')
    expect(blob).toContain('timeout')
  })

  it('binds stream_end to the wired row after a duplicate send_click', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    const sk = 'sk-rebind'
    mod.logChatTurnSendClick({ sessionKey: sk, text: '同一句' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: sk })
    mod.logChatTurnSendWire({ sessionKey: sk })
    mod.logChatTurnRunStarted({ sessionKey: sk, runId: 'run-live' })
    vi.setSystemTime(new Date('2026-11-20T01:00:01.000Z'))
    mod.logChatTurnFirstResponse({
      sessionKey: sk,
      kind: 'text',
      preview: 'hi',
      runId: 'run-live',
    })
    // 连点顶掉 activeTimingId（空壳行）
    vi.setSystemTime(new Date('2026-11-20T01:00:02.000Z'))
    mod.logChatTurnSendClick({ sessionKey: sk, text: '同一句' })
    vi.setSystemTime(new Date('2026-11-20T01:00:40.000Z'))
    mod.logChatTurnStreamEnd({
      sessionKey: sk,
      runId: 'run-live',
      outcome: 'sse_final',
      trigger: 'sse_final',
      hasEndMarker: true,
    })
    const rows = mod.listChatTurnTimingRows({ sessionKey: sk })
    const live = rows.find((r) => r.runId === 'run-live' || r.firstResponseAt != null)
    expect(live).toBeTruthy()
    expect(live.outcome).toBe('sse_final')
    expect(live.streamEndAt).not.toBeNull()
    expect(mod.classifyChatTurnTimingVerdict(live).level).toBe('ok')
  })

  it('prunes old ok turns but keeps abnormal', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 20, 2, 0, i)))
      const sk = 'sk-prune'
      mod.logChatTurnSendClick({ sessionKey: sk, text: `ok-${i}` })
      mod.logChatTurnUserBubbleVisible({ sessionKey: sk })
      mod.logChatTurnSendWire({ sessionKey: sk })
      mod.logChatTurnRunStarted({ sessionKey: sk, runId: `r-${i}` })
      mod.logChatTurnFirstResponse({
        sessionKey: sk,
        kind: 'text',
        preview: 'x',
        runId: `r-${i}`,
      })
      mod.logChatTurnStreamEnd({
        sessionKey: sk,
        runId: `r-${i}`,
        outcome: 'sse_final',
        trigger: 'sse_final',
        hasEndMarker: true,
      })
    }
    // 再塞一条异常：未上线
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 20, 2, 1, 0)))
    mod.logChatTurnSendClick({ sessionKey: 'sk-prune', text: 'bad-last' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: 'sk-prune' })
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 20, 2, 1, 8)))

    const rows = mod.listChatTurnTimingRows({ sessionKey: 'sk-prune' })
    const okCount = rows.filter(
      (r) => mod.classifyChatTurnTimingVerdict(r).level === 'ok',
    ).length
    const bad = rows.filter((r) => (r.textPreview || '').includes('bad-last'))
    expect(okCount).toBeLessThanOrEqual(8)
    expect(bad.length).toBe(1)
  })
})
