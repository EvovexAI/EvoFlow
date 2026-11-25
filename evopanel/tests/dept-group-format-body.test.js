import { describe, it, expect } from 'vitest'
import {
  unwrapSpokenReplyJson,
  formatBodyText,
} from '../src/react/components/HomeDeptGroupChat.tsx'

describe('dept group formatBodyText / spoken JSON', () => {
  it('unwrapSpokenReplyJson keeps plain text', () => {
    expect(unwrapSpokenReplyJson('普通回复')).toBe('普通回复')
    expect(unwrapSpokenReplyJson('')).toBe('')
  })

  it('unwrapSpokenReplyJson extracts say from heard/say/gap/avoid object', () => {
    const raw = JSON.stringify({
      heard: '哈哈哈',
      say: '咱们刚聊到知识库里不少AI相关术语，像CLI、API这些，要是有想了解的，随时说哈',
      gap: '',
      avoid: '',
    })
    expect(unwrapSpokenReplyJson(raw)).toBe(
      '咱们刚聊到知识库里不少AI相关术语，像CLI、API这些，要是有想了解的，随时说哈',
    )
  })

  it('formatBodyText peels fenced spoken JSON to say only', () => {
    const fenced = '```json\n{"heard":"hi","say":"你好呀","gap":"","avoid":""}\n```'
    expect(formatBodyText(fenced)).toBe('你好呀')
  })

  it('formatBodyText does not swallow unrelated JSON with say field', () => {
    const other = JSON.stringify({ say: 'x', tool: 'bash', id: 1 })
    expect(formatBodyText(other)).toContain('tool')
  })
})
