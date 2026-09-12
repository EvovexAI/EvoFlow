import { describe, expect, it } from 'vitest'
import { bindingToGlobalShortcut } from '../src/lib/background-voice.js'
import { demoTranscriptResult, isVoiceDemoActive, makeDemoLevels, startVoiceDemo, stopVoiceDemo } from '../src/lib/voice-demo-mode.js'
import { isMicrophoneAccessError } from '../src/lib/speech-audio.js'
import {
  isPreferXiaomiVoice,
  isXiaomiVoiceSendHandlerReady,
  registerXiaomiVoiceSendHandler,
  sendVoiceTranscript,
  setPreferXiaomiVoice,
  unregisterXiaomiVoiceSendHandler,
} from '../src/lib/background-voice-bridge.js'

describe('background-voice', () => {
  it('converts binding to global shortcut string', () => {
    expect(
      bindingToGlobalShortcut({
        alt: true,
        ctrl: false,
        shift: false,
        meta: false,
        code: 'KeyX',
        key: 'x',
      }),
    ).toBe('Alt+X')
  })

  it('returns null when shortcut disabled', () => {
    expect(bindingToGlobalShortcut({ disabled: true, code: 'KeyV', key: 'v' })).toBeNull()
  })
})

describe('wake voice routes to xiaomi', () => {
  it('sends to xiaomi handler when preferXiaomiVoice', async () => {
    const got = []
    registerXiaomiVoiceSendHandler(async (text, opts) => {
      got.push({ text, xiaomi: opts?.xiaomi })
    })
    setPreferXiaomiVoice(true)
    expect(isPreferXiaomiVoice()).toBe(true)
    expect(isXiaomiVoiceSendHandlerReady()).toBe(true)
    await sendVoiceTranscript('查一下进度', { global: true })
    expect(got).toEqual([{ text: '查一下进度', xiaomi: true }])
    setPreferXiaomiVoice(false)
    unregisterXiaomiVoiceSendHandler()
  })
})

describe('speech-audio mic detection', () => {
  it('detects wrapped Chinese microphone error', () => {
    const err = new Error(
      '未找到可用麦克风。请确认电脑已连接/启用输入设备，并在 Windows「设置 → 隐私 → 麦克风」中允许桌面应用访问。',
    )
    expect(isMicrophoneAccessError(err)).toBe(true)
  })

  it('detects NotFoundError by name', () => {
    const err = new Error('x')
    err.name = 'NotFoundError'
    expect(isMicrophoneAccessError(err)).toBe(true)
  })
})

describe('voice-demo-mode', () => {
  it('generates demo spectrum levels', () => {
    const levels = makeDemoLevels(1.5)
    expect(levels).toHaveLength(24)
    expect(levels.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('starts and stops demo mode', () => {
    const partials = []
    startVoiceDemo({ onPartial: (t) => partials.push(t) })
    expect(isVoiceDemoActive()).toBe(true)
    stopVoiceDemo()
    expect(isVoiceDemoActive()).toBe(false)
    expect(partials.length).toBeGreaterThan(0)
  })

  it('returns demo transcript', () => {
    expect(demoTranscriptResult()).toContain('会议纪要')
  })
})
