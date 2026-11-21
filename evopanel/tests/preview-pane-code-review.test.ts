import { describe, expect, it } from 'vitest'
import { resolveCodeReviewContentProjection } from '../src/zcode-ui/previewPaneCodeReview.ts'
import type { CodeReviewCodeViewerSource } from '../src/zcode-ui/lib/codeViewer.ts'

function makeSource(
  overrides: Partial<CodeReviewCodeViewerSource> & {
    review?: CodeReviewCodeViewerSource['review'] | undefined
  } = {},
): CodeReviewCodeViewerSource {
  return {
    type: 'code-review',
    title: 'demo.ts',
    path: 'demo.ts',
    review: {
      requestId: 'req-1',
      title: 'note',
      body: 'look here',
      startLine: 2,
      endLine: 3,
    },
    ...overrides,
  } as CodeReviewCodeViewerSource
}

describe('resolveCodeReviewContentProjection', () => {
  it('does not crash when review payload is missing', () => {
    const source = makeSource({ review: undefined })
    const projection = resolveCodeReviewContentProjection(source, 'a\nb\nc\n')
    expect(projection.focusedRange).toBeNull()
    expect(projection.inlineComments).toEqual([])
    expect(projection.topComment).toBeNull()
    expect(projection.targetLineOutOfRange).toBe(false)
  })

  it('projects a visible line range into focusedRange + inline comment', () => {
    const projection = resolveCodeReviewContentProjection(makeSource(), 'a\nb\nc\n')
    expect(projection.focusedRange).toEqual({ startLine: 2, endLine: 3 })
    expect(projection.inlineComments).toHaveLength(1)
    expect(projection.topComment).toBeNull()
    expect(projection.targetLineOutOfRange).toBe(false)
  })

  it('falls back to topComment when range is outside file', () => {
    const projection = resolveCodeReviewContentProjection(
      makeSource({
        review: {
          requestId: 'req-2',
          title: 'note',
          body: 'missing',
          startLine: 99,
          endLine: 99,
        },
      }),
      'a\nb\n',
    )
    expect(projection.focusedRange).toBeNull()
    expect(projection.inlineComments).toEqual([])
    expect(projection.topComment?.comment).toBe('missing')
    expect(projection.targetLineOutOfRange).toBe(true)
  })
})
