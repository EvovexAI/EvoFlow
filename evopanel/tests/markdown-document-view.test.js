import { describe, expect, it } from 'vitest'
import { isMarkdownDocumentPath } from '../src/react/components/MarkdownDocumentView.tsx'

describe('isMarkdownDocumentPath', () => {
  it('detects md extensions', () => {
    expect(isMarkdownDocumentPath('a.md')).toBe(true)
    expect(isMarkdownDocumentPath('docs/x/口播稿.md')).toBe(true)
    expect(isMarkdownDocumentPath('note.markdown')).toBe(true)
    expect(isMarkdownDocumentPath('readme.MDX')).toBe(true)
  })

  it('rejects non-markdown', () => {
    expect(isMarkdownDocumentPath('a.txt')).toBe(false)
    expect(isMarkdownDocumentPath('a.py')).toBe(false)
    expect(isMarkdownDocumentPath('')).toBe(false)
  })
})
