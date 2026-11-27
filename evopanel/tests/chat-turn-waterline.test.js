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
      stopHints: [
        {
          atMs: Date.parse('2026-11-20T01:00:02.000Z'),
          whoZh: '用户点击 V4 停止按钮',
          trigger: 'v4_stop_button',
          kind: 'ui_stop',
          sessionKey: 'sk-ok',
          fromUiStopButton: true,
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
    expect(blob).toContain('停止归因')
    expect(blob).toContain('用户点击 V4 停止按钮')
    expect(blob).toContain('v4_stop_button')
  })

  it('stores endWhoZh on stream_end and surfaces it on waterline', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    const sk = 'sk-who'
    mod.logChatTurnSendClick({ sessionKey: sk, text: '谁停的' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: sk })
    mod.logChatTurnSendWire({ sessionKey: sk })
    mod.logChatTurnRunStarted({ sessionKey: sk, runId: 'r-who' })
    mod.logChatTurnFirstResponse({
      sessionKey: sk,
      kind: 'text',
      preview: '…',
      runId: 'r-who',
    })
    mod.logChatTurnStreamEnd({
      sessionKey: sk,
      runId: 'r-who',
      outcome: 'sse_aborted',
      whoZh: '网关冷 attach：后端批量停止 panel run（非用户点停）',
      trigger: 'client_attach',
      hasEndMarker: false,
    })
    const row = mod.listChatTurnTimingRows({ sessionKey: sk }).find((r) => r.runId === 'r-who')
    expect(row?.endWhoZh).toContain('非用户点停')
    expect(row?.endTrigger).toBe('client_attach')
    const blob = mod
      .formatChatTurnWaterlineForDiag({
        sessionKey: sk,
        stopHints: [
          {
            atMs: Date.now(),
            whoZh: '网关冷 attach：后端批量停止 panel run（非用户点停）',
            trigger: 'client_attach',
            kind: 'abnormal',
            sessionKey: sk,
          },
        ],
      })
      .join('\n')
    expect(blob).toContain('谁=网关冷 attach')
    expect(blob).toContain('client_attach')
  })

  it('surfaces stream_error errMsg as 原因 on waterline and stopHints', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    const sk = 'sk-err'
    mod.logChatTurnSendClick({ sessionKey: sk, text: '工具中途停' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: sk })
    mod.logChatTurnSendWire({ sessionKey: sk })
    mod.logChatTurnRunStarted({ sessionKey: sk, runId: 'r-err' })
    mod.logChatTurnFirstResponse({
      sessionKey: sk,
      kind: 'tool',
      preview: 'bash',
      runId: 'r-err',
    })
    const errMsg =
      '本轮生成失败：模型服务临时内部错误，直接再发一次通常就能过'
    mod.logChatTurnStreamEnd({
      sessionKey: sk,
      runId: 'r-err',
      outcome: 'stream_error',
      whoZh: '流错误结束',
      trigger: 'stream_error',
      hasEndMarker: false,
      detail: { errMsg, rawErr: 'An internal error occurred' },
    })
    const row = mod.listChatTurnTimingRows({ sessionKey: sk }).find((r) => r.runId === 'r-err')
    expect(row?.endErrMsg).toContain('模型服务临时内部错误')
    const blob = mod
      .formatChatTurnWaterlineForDiag({
        sessionKey: sk,
        stopHints: [
          {
            atMs: Date.now(),
            whoZh: '流错误结束',
            trigger: 'stream_error',
            kind: 'abnormal',
            sessionKey: sk,
            errMsg,
          },
        ],
      })
      .join('\n')
    expect(blob).toContain('原因: 本轮生成失败：模型服务临时内部错误')
    expect(blob).toContain('原因=本轮生成失败：模型服务临时内部错误')
    expect(blob).toContain('异常·流错误')
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

  it('does not fire stream_end_missing while V4/tool activity keeps heartbeating', async () => {
    const mod = await import('../src/react/lib/chat-turn-timing-log.ts')
    const sk = 'sk-long-run'
    mod.logChatTurnSendClick({ sessionKey: sk, text: '长跑' })
    mod.logChatTurnUserBubbleVisible({ sessionKey: sk })
    mod.logChatTurnSendWire({ sessionKey: sk })
    mod.logChatTurnRunStarted({ sessionKey: sk, runId: 'r-long' })
    mod.logChatTurnFirstResponse({
      sessionKey: sk,
      kind: 'tool',
      preview: 'bash',
      runId: 'r-long',
    })
    // 每隔 2 分钟有活动，共 12 分钟——旧逻辑会在首字后 5 分钟误报
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2 * 60_000)
      mod.noteChatTurnStreamActivity({ sessionKey: sk, kind: 'tool', preview: `tick-${i}` })
    }
    const anomaliesQuiet = mod
      .listChatTurnAnomalies()
      .filter((a) => a.event === 'stream_end_missing' && a.sessionKey === sk)
    expect(anomaliesQuiet).toHaveLength(0)
    const row = mod.listChatTurnTimingRows({ sessionKey: sk }).find((r) => r.runId === 'r-long')
    expect(mod.classifyChatTurnTimingVerdict(row).level).toBe('pending')

    // 真正静默 5 分钟才应记死
    vi.advanceTimersByTime(5 * 60_000 + 100)
    const anomaliesDead = mod
      .listChatTurnAnomalies()
      .filter((a) => a.event === 'stream_end_missing' && a.sessionKey === sk)
    expect(anomaliesDead.length).toBeGreaterThanOrEqual(1)
    expect(anomaliesDead[0].zh).toMatch(/静默/)
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
