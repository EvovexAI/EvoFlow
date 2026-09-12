import { describe, expect, it } from 'vitest'
import {
  MAX_DIFF_RENDER_ROWS,
  buildContextualFileDiff,
  buildFragmentFileDiff,
  buildWriteAddedRows,
} from '../src/react/file-diff-util.ts'

describe('file-diff-util performance caps', () => {
  it('caps contextual diff LCS input and render rows', () => {
    const before = Array.from({ length: 400 }, (_, i) => `before-${i}`)
    const after = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? `before-${i}` : `after-${i}`))
    const view = buildContextualFileDiff(before.join('\n'), after.join('\n'))
    expect(view.truncated).toBeTruthy()
    expect(view.rows.length).toBeLessThanOrEqual(MAX_DIFF_RENDER_ROWS + 1)
  })

  it('caps fragment diff rows', () => {
    const oldLines = Array.from({ length: 120 }, (_, i) => `old-${i}`).join('\n')
    const newLines = Array.from({ length: 120 }, (_, i) => `new-${i}`).join('\n')
    const view = buildFragmentFileDiff(oldLines, newLines)
    expect(view.truncated).toBeTruthy()
    expect(view.rows.length).toBeLessThanOrEqual(MAX_DIFF_RENDER_ROWS + 1)
    expect(view.added).toBe(120)
    expect(view.removed).toBe(120)
  })

  it('caps write preview rows but keeps full added count', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n')
    const view = buildWriteAddedRows(content, 20)
    expect(view.truncated).toBeTruthy()
    expect(view.added).toBe(100)
    expect(view.rows.length).toBeLessThanOrEqual(21)
  })
})

describe('computeFileEditDiffStats', () => {
  it('counts write content lines without building diff rows', async () => {
    const { computeFileEditDiffStats, formatFileEditDiffStatBrief } = await import(
      '../src/react/file-diff-util.ts'
    )
    const stats = computeFileEditDiffStats({ action: 'write', content: 'a\nb\nc' })
    expect(stats).toEqual({ added: 3, removed: 0 })
    expect(formatFileEditDiffStatBrief(stats, 'write')).toBe('+3')
  })

  it('counts replace fragment lines', async () => {
    const { computeFileEditDiffStats, formatFileEditDiffStatBrief } = await import(
      '../src/react/file-diff-util.ts'
    )
    const stats = computeFileEditDiffStats({
      action: 'replace',
      old_string: 'x\ny',
      new_string: 'a\nb\nc',
    })
    expect(stats).toEqual({ added: 3, removed: 2 })
    expect(formatFileEditDiffStatBrief(stats, 'replace')).toBe('+3 −2')
  })

  it('formats delete action', async () => {
    const { formatFileEditDiffStatBrief } = await import('../src/react/file-diff-util.ts')
    expect(formatFileEditDiffStatBrief({ added: 0, removed: 0 }, 'delete')).toBe('')
  })
})
