import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceFilePreviewPane } from '../src/react/components/WorkspaceFilePreviewPane.tsx'

afterEach(() => cleanup())

function preview(over: Record<string, unknown> = {}) {
  return {
    path: 'outputs/report.html',
    name: 'report.html',
    loading: false,
    content: '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>',
    error: null,
    binary: false,
    truncated: false,
    size: 128,
    ...over,
  } as never
}

describe('WorkspaceFilePreviewPane 视图切换', () => {
  it('renders HTML preview by default and offers a source toggle', () => {
    render(<WorkspaceFilePreviewPane preview={preview()} />)
    expect(document.querySelector('.react-chat-workspace-preview-html')).not.toBeNull()
    expect(screen.getByTestId('ws-preview-toggle-source')).toBeTruthy()
    expect(screen.getByTestId('ws-preview-toggle-render')).toBeTruthy()
  })

  it('switches HTML to source and back without losing the toggle', () => {
    render(<WorkspaceFilePreviewPane preview={preview()} />)
    fireEvent.click(screen.getByTestId('ws-preview-toggle-source'))
    expect(document.querySelector('.react-chat-workspace-preview-html')).toBeNull()
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('<!DOCTYPE html>')
    expect(screen.getByTestId('ws-preview-toggle-source').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByTestId('ws-preview-toggle-render'))
    expect(document.querySelector('.react-chat-workspace-preview-html')).not.toBeNull()
    expect(screen.queryByTestId('ws-preview-source')).toBeNull()
  })

  it('offers 预览 / 源码 for Markdown too', () => {
    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'docs/notes.md', name: 'notes.md', content: '# 标题\n\n正文' })}
      />,
    )
    expect(screen.getByTestId('ws-preview-toggle-render').textContent).toBe('预览')
    fireEvent.click(screen.getByTestId('ws-preview-toggle-source'))
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('# 标题')
  })

  it('keeps non-renderable files source-only (no toggle)', () => {
    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'scripts/run.py', name: 'run.py', content: 'print(1)' })}
      />,
    )
    expect(screen.queryByTestId('ws-preview-toggle-source')).toBeNull()
    expect(document.querySelector('code')?.textContent).toContain('print(1)')
  })

  it('forces source for in-flight HTML writes (streaming)', () => {
    render(<WorkspaceFilePreviewPane preview={preview({ streaming: true })} />)
    expect(document.querySelector('.react-chat-workspace-preview-html')).toBeNull()
    expect(screen.queryByTestId('ws-preview-toggle-source')).toBeNull()
  })
})
