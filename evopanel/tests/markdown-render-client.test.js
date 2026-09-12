import { describe, expect, it } from 'vitest'
import { normalizeCjkTypographyForMarkdown, renderMarkdownStreaming } from '../src/lib/markdown.js'
import { renderMarkdownStreamingAsync } from '../src/lib/markdown-render-client.ts'

describe('markdown-render-client', () => {
  it('renderMarkdownStreamingAsync matches sync fallback in test env', async () => {
    const raw = 'Hello **world**\n\n```js\nconst x = 1\n```'
    const sync = renderMarkdownStreaming(raw)
    const asyncHtml = await renderMarkdownStreamingAsync(raw)
    expect(asyncHtml).toBe(sync)
  })
})

describe('normalizeCjkTypographyForMarkdown', () => {
  it('converts ASCII quotes to curly quotes in Chinese prose', () => {
    expect(normalizeCjkTypographyForMarkdown('他说"你好"然后离开')).toBe(
      '他说\u201c你好\u201d然后离开',
    )
  })

  it('leaves code blocks unchanged', () => {
    const md = '说明 `const x = "a"` 以及\n```js\nconst s = "raw"\n```\n结束"引号"'
    const out = normalizeCjkTypographyForMarkdown(md)
    expect(out).toContain('`const x = "a"`')
    expect(out).toContain('const s = "raw"')
    expect(out.endsWith('结束\u201c引号\u201d')).toBe(true)
  })

  it('skips pure English text', () => {
    expect(normalizeCjkTypographyForMarkdown('say "hello"')).toBe('say "hello"')
  })
})
