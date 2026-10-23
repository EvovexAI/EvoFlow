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

describe('新增格式：SVG / JSON / CSV / Mermaid', () => {
  it('renders SVG as image and can switch to source', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
    render(<WorkspaceFilePreviewPane preview={preview({ path: 'assets/logo.svg', name: 'logo.svg', content: svg })} />)
    const img = document.querySelector('[data-testid="ws-preview-svg"] img') as HTMLImageElement | null
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src') || '').toContain('data:image/svg+xml')

    fireEvent.click(screen.getByTestId('ws-preview-toggle-source'))
    expect(document.querySelector('[data-testid="ws-preview-svg"]')).toBeNull()
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('<rect')
    expect(screen.getByTestId('ws-preview-toggle-render').textContent).toBe('渲染')
  })

  it('pretty-prints JSON and falls back to source when invalid', () => {
    const { unmount } = render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'data/a.json', name: 'a.json', content: '{"b":1}' })}
      />,
    )
    expect(screen.getByTestId('ws-preview-toggle-render').textContent).toBe('格式化')
    expect(window.document.querySelector('[data-testid="ws-preview-json"]')?.textContent).toContain('"b": 1')
    unmount()

    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'data/broken.json', name: 'broken.json', content: '{oops}' })}
      />,
    )
    expect(document.querySelector('[data-testid="ws-preview-json"]')).toBeNull()
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('JSON 解析失败')
  })

  it('renders CSV as a table and switches back to raw text', () => {
    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'data/rows.csv', name: 'rows.csv', content: ['name,age', 'Li,30', 'Wang,25'].join('\n') })}
      />,
    )
    const table = document.querySelector('[data-testid="ws-preview-table"] table')
    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('thead th')).toHaveLength(2)
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(screen.getByTestId('ws-preview-toggle-render').textContent).toBe('表格')

    fireEvent.click(screen.getByTestId('ws-preview-toggle-source'))
    expect(document.querySelector('[data-testid="ws-preview-table"]')).toBeNull()
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('name,age')
  })

  it('renders Mermaid source through the diagram renderer', () => {
    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'diagram/flow.mmd', name: 'flow.mmd', content: ['flowchart TD', ' A-->B'].join('\n') })}
      />,
    )
    expect(screen.getByTestId('ws-preview-toggle-render').textContent).toBe('图表')
    expect(document.querySelector('[data-testid="ws-preview-mermaid"]')).not.toBeNull()
    fireEvent.click(screen.getByTestId('ws-preview-toggle-source'))
    expect(screen.getByTestId('ws-preview-source').textContent).toContain('flowchart TD')
  })

  it('keeps svg/mermaid source-only while streaming', () => {
    render(
      <WorkspaceFilePreviewPane
        preview={preview({ path: 'assets/logo.svg', name: 'logo.svg', content: '<svg></svg>', streaming: true })}
      />,
    )
    expect(screen.queryByTestId('ws-preview-toggle-source')).toBeNull()
    expect(document.querySelector('[data-testid="ws-preview-svg"]')).toBeNull()
  })
})
