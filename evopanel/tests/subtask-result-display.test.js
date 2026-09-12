import { describe, expect, it } from 'vitest'
import {
  joinTextContentParts,
  normalizeSubtaskResultForDisplay,
} from '../src/lib/subtask-result-display.js'

describe('joinTextContentParts', () => {
  it('joins stream deltas in one message', () => {
    expect(joinTextContentParts(['你', '好', '世'])).toBe('你好世')
    expect(joinTextContentParts(['Hello', 'world'])).toBe('Hello world')
  })
})

describe('normalizeSubtaskResultForDisplay', () => {
  it('collapses per-character line breaks from broken streams', () => {
    const raw = '你\n好\n世\n界\n'
    expect(normalizeSubtaskResultForDisplay(raw)).toBe('你好世界')
  })

  it('collapses one-word-per-line English stream', () => {
    const raw = 'Hello\nworld\nthis\nis\na\ntest\n'
    expect(normalizeSubtaskResultForDisplay(raw)).toBe('Hello world this is a test')
  })

  it('collapses one-word-per-line Chinese stream', () => {
    const raw = '正在\n分析\n项目\n结构\n'
    expect(normalizeSubtaskResultForDisplay(raw)).toBe('正在分析项目结构')
  })

  it('leaves normal paragraphs unchanged', () => {
    const raw = 'line one\n\nline two\n\nline three'
    expect(normalizeSubtaskResultForDisplay(raw)).toBe(raw)
  })

  it('collapses text joined with newlines from stream segments', () => {
    const joined = ['Hello', 'world', 'again'].join('\n')
    expect(normalizeSubtaskResultForDisplay(joined)).toBe('Hello world again')
  })

  it('leaves markdown lists unchanged', () => {
    const raw = '- item one\n- item two\n- item three'
    expect(normalizeSubtaskResultForDisplay(raw)).toBe(raw)
  })
})
