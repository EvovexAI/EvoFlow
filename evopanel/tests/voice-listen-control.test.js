import { describe, expect, it } from 'vitest'
import { isStopListenCommand, isStopTtsOnlyCommand } from '../src/lib/voice-listen-control.js'

describe('voice-listen-control', () => {
  it('matches short stop-listen phrases', () => {
    expect(isStopListenCommand('停止')).toBe(true)
    expect(isStopListenCommand('别听了')).toBe(true)
    expect(isStopListenCommand('先这样。')).toBe(true)
    expect(isStopListenCommand('请停止')).toBe(true)
  })

  it('ignores long sentences that only contain 停止', () => {
    expect(isStopListenCommand('请停止当前正在运行的数据分析任务并输出报告')).toBe(false)
  })

  it('matches stop-tts-only phrases', () => {
    expect(isStopTtsOnlyCommand('停止播报')).toBe(true)
    expect(isStopTtsOnlyCommand('别播了')).toBe(true)
    expect(isStopTtsOnlyCommand('停止')).toBe(false)
  })
})
