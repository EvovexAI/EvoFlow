import { describe, expect, it } from 'vitest'
import {
  shouldAdvanceVoiceSpeechSync,
  shouldMuteVoiceSpeech,
  resolveVoiceSpeechBodyFromParts,
  toVoiceSpeechPlain,
  clipVoiceSpeechForPlayback,
} from '../src/lib/voice-reply-speech.js'

describe('voice-reply-speech', () => {
  it('resolves speech body from stream parts consistently', () => {
    expect(
      resolveVoiceSpeechBodyFromParts({
        text: '你好',
      }),
    ).toBe('你好')
    expect(
      resolveVoiceSpeechBodyFromParts({
        hostedCaptureText: '托管正文',
        text: '流式',
      }),
    ).toBe('托管正文')
  })

  it('sync gate uses plainText prefix not length', () => {
    const a = toVoiceSpeechPlain('你好，世界')
    const b = toVoiceSpeechPlain('你好，世界！')
    expect(shouldAdvanceVoiceSpeechSync('你好，世界', '')).toBe(true)
    expect(shouldAdvanceVoiceSpeechSync('你好，世界', a)).toBe(false)
    expect(shouldAdvanceVoiceSpeechSync('你好，世界！', a)).toBe(true)
    expect(shouldAdvanceVoiceSpeechSync('你好，世界！', b)).toBe(false)
  })

  it('does not stop at a short leading sentence when more content follows', () => {
    const body =
      '好的，我来帮你看一下。' +
      '这个问题主要有三点：第一是权限配置，第二是缓存过期，第三是依赖版本不一致。' +
      '建议先核对 API Key，再清缓存后重试。'
    const clipped = clipVoiceSpeechForPlayback(body)
    expect(clipped.startsWith('好的，我来帮你看一下。')).toBe(true)
    expect(clipped.includes('三点')).toBe(true)
    expect(clipped.length).toBeGreaterThan(40)
    // still capped for long essays
    const long = `${'这是一段很长的说明文字。'.repeat(40)}结尾。`
    expect(clipVoiceSpeechForPlayback(long).length).toBeLessThanOrEqual(400)
  })

  it('truncates next sentence into budget instead of dropping it', () => {
    const s1 = '好的。'
    const s2 = '后面是一整段很长很长很长很长很长很长的解释内容，用来验证截断而不是整句丢弃。'
    const clipped = clipVoiceSpeechForPlayback(s1 + s2, { maxChars: 40, maxSentences: 4 })
    expect(clipped.startsWith('好的。')).toBe(true)
    expect(clipped.length).toBeGreaterThan('好的。'.length)
    expect(clipped.length).toBeLessThanOrEqual(40)
  })

  it('mutes while tools are running', () => {
    expect(shouldMuteVoiceSpeech([{ status: 'running', name: 'read_file' }])).toBe(true)
    expect(shouldMuteVoiceSpeech([{ status: 'in_progress', name: 'bash' }])).toBe(true)
  })

  it('does not mute when tools finished', () => {
    expect(shouldMuteVoiceSpeech([{ status: 'ok', name: 'read_file' }])).toBe(false)
    expect(shouldMuteVoiceSpeech([])).toBe(false)
  })

  it('mutes while waiting tool approval', () => {
    expect(shouldMuteVoiceSpeech([{ status: 'pending_approval', name: 'bash' }])).toBe(true)
  })
})
