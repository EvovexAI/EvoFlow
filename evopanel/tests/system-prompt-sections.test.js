import { describe, expect, it } from 'vitest'
import {
  labelForSystemPromptTag,
  splitSystemPromptSections,
} from '../src/react/lib/system-prompt-sections.ts'

describe('splitSystemPromptSections', () => {
  it('splits known employee assembly blocks', () => {
    const raw = `You are helpful.
<identity>
岗: 产品经理
</identity>
<contract>
职责：推进需求
</contract>
<footer note>`
    const sections = splitSystemPromptSections(raw)
    expect(sections.map((s) => s.tag)).toEqual([
      '_preamble',
      'identity',
      'contract',
      '_tail',
    ])
    expect(sections[1].label).toBe('身份')
    expect(sections[2].text).toContain('</contract>')
  })

  it('returns single full section when no tags', () => {
    const sections = splitSystemPromptSections('plain system prompt')
    expect(sections).toHaveLength(1)
    expect(sections[0].tag).toBe('_full')
  })

  it('labels known tags', () => {
    expect(labelForSystemPromptTag('mission_state')).toBe('任务状态')
    expect(labelForSystemPromptTag('unknown_xyz')).toBe('unknown_xyz')
  })
})
