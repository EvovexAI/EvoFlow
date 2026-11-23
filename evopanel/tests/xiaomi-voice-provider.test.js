import { describe, expect, it, beforeEach } from 'vitest'
import {
  getXiaomiAsrProvider,
  getXiaomiTtsProvider,
  setXiaomiAsrProvider,
  setXiaomiTtsProvider,
  setXiaomiTtsSpeaker,
  resolveXiaomiTtsSpeaker,
  preferDashscopeWhenVolcMissing,
  XIAOMI_DEFAULT_TTS_SPEAKER,
  XIAOMI_DEFAULT_DASHSCOPE_SPEAKER,
} from '../src/lib/xiaomi-voice/config.js'

describe('xiaomi voice provider / speaker', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('resolveXiaomiTtsSpeaker drops volc speaker when TTS is dashscope', () => {
    setXiaomiTtsProvider('dashscope', { resetSpeaker: false })
    setXiaomiTtsSpeaker(XIAOMI_DEFAULT_TTS_SPEAKER)
    expect(resolveXiaomiTtsSpeaker()).toBe(XIAOMI_DEFAULT_DASHSCOPE_SPEAKER)
  })

  it('resolveXiaomiTtsSpeaker drops dashscope voice when TTS is volc', () => {
    setXiaomiTtsProvider('volcengine', { resetSpeaker: false })
    setXiaomiTtsSpeaker('longanlingxin')
    expect(resolveXiaomiTtsSpeaker()).toBe(XIAOMI_DEFAULT_TTS_SPEAKER)
  })

  it('preferDashscopeWhenVolcMissing switches default volc → dashscope', () => {
    setXiaomiAsrProvider('volcengine')
    setXiaomiTtsProvider('volcengine', { resetSpeaker: false })
    const r = preferDashscopeWhenVolcMissing({
      dashscopeKey: 'sk-sp-test',
      dashscopeTtsEnabled: true,
      volcSpeechKey: '',
      volcTtsEnabled: false,
    })
    expect(r.switched).toBe(true)
    expect(getXiaomiAsrProvider()).toBe('dashscope')
    expect(getXiaomiTtsProvider()).toBe('dashscope')
  })

  it('preferDashscopeWhenVolcMissing keeps volc when both usable', () => {
    setXiaomiAsrProvider('volcengine')
    setXiaomiTtsProvider('volcengine', { resetSpeaker: false })
    const r = preferDashscopeWhenVolcMissing({
      dashscopeKey: 'sk-sp-test',
      dashscopeTtsEnabled: true,
      volcSpeechKey: 'ark-xxx',
      volcTtsEnabled: true,
    })
    expect(r.switched).toBe(false)
    expect(getXiaomiTtsProvider()).toBe('volcengine')
  })
})
