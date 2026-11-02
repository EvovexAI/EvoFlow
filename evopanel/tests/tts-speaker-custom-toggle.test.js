/**
 * TTS 音色字段:「自定义音色」勾选框是 UI 模式切换,不应改写/清空已配置音色。
 * 回归根因:勾选时 syncCustomMode 用空的自定义输入覆盖 hidden 值,
 * 配合面板自动保存(media.js change 委托)把已配置的预设音色清空落盘。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/lib/speech-client.js', () => ({
  fetchSpeechConfigured: vi.fn(async () => false),
  previewSpeechTts: vi.fn(),
  stopAllAssistantSpeech: vi.fn(),
}))

import {
  buildTtsSpeakerFieldHtml,
  bindTtsSpeakerFields,
  readTtsSpeakerDraft,
} from '../src/components/tts-speaker-picker.js'

const PRESETS = [
  { value: 'zh_female_a', label: '音色A' },
  { value: 'zh_female_b', label: '音色B' },
]
const FIELD = 'volcengineTtsSpeaker'

function mountField(creds = { [FIELD]: 'zh_female_a' }) {
  document.body.innerHTML = `<div id="host">${buildTtsSpeakerFieldHtml(
    FIELD,
    '朗读音色',
    PRESETS,
    creds,
    { showVoiceId: true },
  )}</div>`
  const host = document.getElementById('host')
  bindTtsSpeakerFields(host, PRESETS)
  return host
}

const hiddenValue = (host) =>
  host.querySelector(`[data-media-tts-speaker-value="${FIELD}"]`).value

describe('tts speaker custom-mode toggle', () => {
  it('entering custom mode does not clobber the configured voice', () => {
    const host = mountField()
    host.querySelector('[data-tts-speaker-custom-mode]').click()
    expect(hiddenValue(host)).toBe('zh_female_a')
    // 自定义输入为空时,draft 必须回落到当前已配置值,不能把空串交给自动保存
    expect(readTtsSpeakerDraft(host)[FIELD]).toBe('zh_female_a')
  })

  it('unchecking custom mode restores the previous voice', () => {
    const host = mountField()
    const cb = host.querySelector('[data-tts-speaker-custom-mode]')
    cb.click()
    cb.click()
    expect(hiddenValue(host)).toBe('zh_female_a')
    expect(readTtsSpeakerDraft(host)[FIELD]).toBe('zh_female_a')
  })

  it('typing a custom voice updates the draft value', () => {
    const host = mountField()
    const group = host.querySelector('[data-media-tts-speaker-group]')
    group.querySelector('[data-tts-speaker-custom-mode]').click()
    const input = group.querySelector(`[data-media-tts-speaker-custom="${FIELD}"]`)
    input.value = 'my_custom_voice'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(readTtsSpeakerDraft(host)[FIELD]).toBe('my_custom_voice')
  })
})
