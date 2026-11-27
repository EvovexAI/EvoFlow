import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStreamStopTrace,
  logStreamStop,
  markStreamStopTrace,
  noteStreamStopUiIdle,
  streamStopSinceMs,
} from '../src/react/lib/stream-stop-log.ts'

afterEach(() => {
  clearStreamStopTrace()
})

describe('stream stop sinceStopMs', () => {
  it('marks click and reports sinceStopMs on later events', async () => {
    markStreamStopTrace({
      sessionKey: 'agent:main:demo',
      source: 'composer_stop_button',
    })
    expect(streamStopSinceMs({ sessionKey: 'agent:main:demo' })).toBeGreaterThanOrEqual(0)

    await new Promise((r) => setTimeout(r, 25))
    const kind = logStreamStop({
      sessionKey: 'agent:main:demo',
      trigger: 'stop_api_done',
      hasEndMarker: false,
      skipDedupe: true,
    })
    expect(kind).toBe('normal')
    const since = streamStopSinceMs({ sessionKey: 'agent:main:demo' })
    expect(since).toBeGreaterThanOrEqual(20)
  })

  it('ui_idle_after_stop clears the trace', async () => {
    markStreamStopTrace({
      sessionKey: 'agent:main:demo',
      threadId: 'thread-1',
      source: 'v4_stop_button',
    })
    await new Promise((r) => setTimeout(r, 10))
    noteStreamStopUiIdle({
      sessionKey: 'agent:main:demo',
      threadId: 'thread-1',
    })
    expect(streamStopSinceMs({ sessionKey: 'agent:main:demo' })).toBeNull()
  })

  it('matches threadId when SessionPane logged thread as sessionKey', () => {
    markStreamStopTrace({
      threadId: 'abc-thread',
      source: 'v4_stop_button',
    })
    expect(streamStopSinceMs({ sessionKey: 'abc-thread' })).not.toBeNull()
    expect(streamStopSinceMs({ threadId: 'abc-thread' })).not.toBeNull()
  })

  it('forwards stream_error errMsg into timing row endErrMsg', async () => {
    const { listChatTurnTimingRows, logChatTurnSendClick, logChatTurnSendWire, logChatTurnRunStarted, logChatTurnFirstResponse, logChatTurnUserBubbleVisible } =
      await import('../src/react/lib/chat-turn-timing-log.ts')
    const sk = 'agent:main:stream-err'
    logChatTurnSendClick({ sessionKey: sk, text: 'mid-tool stop' })
    logChatTurnUserBubbleVisible({ sessionKey: sk })
    logChatTurnSendWire({ sessionKey: sk })
    logChatTurnRunStarted({ sessionKey: sk, runId: 'run-err' })
    logChatTurnFirstResponse({
      sessionKey: sk,
      kind: 'tool',
      preview: 'bash',
      runId: 'run-err',
    })
    logStreamStop({
      sessionKey: sk,
      runId: 'run-err',
      trigger: 'stream_error',
      hasEndMarker: false,
      detail: {
        whoZh: '流错误结束',
        errMsg: '本轮生成失败：模型服务临时内部错误，直接再发一次通常就能过',
        rawErr: 'An internal error occurred',
      },
    })
    const row = listChatTurnTimingRows({ sessionKey: sk }).find((r) => r.runId === 'run-err')
    expect(row?.outcome).toBe('stream_error')
    expect(row?.endErrMsg).toContain('模型服务临时内部错误')
  })

  // 【self-evolution-bot · 2026-11-26 · 第133轮 · 模型:deepseek-v4-1-flash-261017】
  // 现网 131 条「新发送前清理旧 SSE wire」全被记成 abnormal/ERROR，诊断表据此报「异常断流」，
  // 但复算 109 条同一会话上一事件已是 sse_final——那是正常空转，不是断流。
  it('records send-prep abort as normal, not abnormal', () => {
    const kind = logStreamStop({
      sessionKey: 'agent:main:prep',
      trigger: 'send_prep_abort_stale_stream',
      hasEndMarker: false,
      skipDedupe: true,
    })
    expect(kind).toBe('normal')
  })

  it('keeps genuinely unterminated streams abnormal', () => {
    const kind = logStreamStop({
      sessionKey: 'agent:main:real-abnormal',
      trigger: 'sse_aborted',
      hasEndMarker: false,
      skipDedupe: true,
    })
    expect(kind).toBe('abnormal')
  })
})
