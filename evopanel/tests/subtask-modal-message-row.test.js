import { describe, expect, it } from 'vitest'
import { prepareSubtaskModalDisplayText } from '../src/react/components/SubtaskModalMessageRow.tsx'

describe('prepareSubtaskModalDisplayText', () => {
  it('merges text segments and fixes one-char-per-line', () => {
    const row = {
      role: 'assistant',
      text: '',
      segments: [
        { kind: 'text', text: '你' },
        { kind: 'text', text: '好' },
        { kind: 'tools', ids: ['t1'] },
      ],
    }
    expect(prepareSubtaskModalDisplayText(row)).toBe('你好')
  })

  it('merges row.text newlines from stream replicas', () => {
    expect(prepareSubtaskModalDisplayText({ text: '你\n好\n世\n界' })).toBe('你好世界')
  })

  it('preserves reasoning segments via structured timeline', () => {
    const row = {
      role: 'assistant',
      text: '',
      segments: [
        { kind: 'reasoning', text: 'step one' },
        { kind: 'text', text: 'answer' },
      ],
    }
    expect(prepareSubtaskModalDisplayText(row)).toBe('answer')
  })

  it('does not duplicate identical text and segment body', () => {
    const body = '好，现在交工提审：'
    expect(
      prepareSubtaskModalDisplayText({
        text: body,
        segments: [{ kind: 'text', text: body }],
      }),
    ).toBe(body)

    const long =
      '好的，现在来写口播稿。根据知识库，我选择「智能体员工」这个核心概念，用反常识+真实痛点作为钩子，适合抖音短视频风格。'
    expect(
      prepareSubtaskModalDisplayText({
        text: long,
        segments: [{ kind: 'text', text: long }],
      }),
    ).toBe(long)
  })
})
