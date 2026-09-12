import { describe, expect, it } from 'vitest'
import {
  normalizeReasoningDisplayText,
  reasoningDisplayParagraphs,
  reasoningPreviewOneLine,
  reasoningStreamOneLine,
  reasoningTailForDisplay,
} from '../src/react/lib/reasoning-display-text.ts'

describe('reasoning-display-text', () => {
  it('collapses single newlines into flowing prose', () => {
    expect(normalizeReasoningDisplayText('用户想要\n修改配置\n需要先读文件')).toBe(
      '用户想要 修改配置 需要先读文件',
    )
  })

  it('preserves paragraph breaks', () => {
    expect(normalizeReasoningDisplayText('第一段行1\n行2\n\n第二段')).toBe('第一段行1 行2\n\n第二段')
  })

  it('builds one-line preview from normalized text', () => {
    expect(reasoningPreviewOneLine('步骤一\n步骤二\n\n步骤三')).toBe('步骤一 步骤二 步骤三')
  })

  it('splits paragraphs for body rendering', () => {
    expect(reasoningDisplayParagraphs('A\nB\n\nC')).toEqual(['A B', 'C'])
  })

  it('tails long streaming text from the end', () => {
    const long = `${'x'.repeat(2000)}\n\n尾部段落`
    const tail = reasoningTailForDisplay(long, 100)
    expect(tail).toContain('尾部段落')
    expect(tail.length).toBeLessThanOrEqual(100)
  })

  it('streams as one line and prefers the latest tail when long', () => {
    expect(reasoningStreamOneLine('先读文件\n再改样式')).toBe('先读文件 再改样式')
    const long = `开头部分 ${'中'.repeat(200)} 最新结论`
    const line = reasoningStreamOneLine(long, 40)
    expect(line.startsWith('…')).toBe(true)
    expect(line).toContain('最新结论')
    expect(line.includes('\n')).toBe(false)
  })
})
