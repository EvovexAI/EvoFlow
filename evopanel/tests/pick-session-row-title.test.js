import { describe, expect, it, beforeEach } from 'vitest'
import { pickSessionRowTitle } from '../src/react/lib/session-list/display.ts'
import { STORAGE_SESSION_NAMES_KEY } from '../src/react/lib/session-list/constants.ts'

describe('pickSessionRowTitle', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefers solid API title over longer previous title (user rename shorter)', () => {
    localStorage.setItem(
      STORAGE_SESSION_NAMES_KEY,
      JSON.stringify({ 'agent:main:main': '这是一段很长的旧标题内容' }),
    )
    expect(
      pickSessionRowTitle('agent:main:main', '短标题', '这是一段很长的旧标题内容'),
    ).toBe('短标题')
  })

  it('uses local cache when API still placeholder', () => {
    localStorage.setItem(
      STORAGE_SESSION_NAMES_KEY,
      JSON.stringify({ 'agent:main:main': '本地标题' }),
    )
    expect(pickSessionRowTitle('agent:main:main', '新对话', '新对话')).toBe('本地标题')
  })

  it('prefers non-provisional soft title over provisional', () => {
    expect(pickSessionRowTitle('agent:main:main', '你好世界...', '正式标题')).toBe('正式标题')
  })
})
