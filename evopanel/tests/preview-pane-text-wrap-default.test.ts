/**
 * 右侧面板预览的自动换行默认值。
 *
 * 背景：V4 右侧面板用的是 ZCode PreviewPane（@pierre/diffs 渲染）。
 * 它的 overflow 由 wrapLongLines 决定，而默认值来自 codePreviewSettings.wrapLongLines = false，
 * 于是 .txt（分镜脚本等纯文本）在窄面板里每行都很宽、必须横向滚动才能读到句尾。
 *
 * 期望：
 *   - 纯文本类（.txt / .log / 无语法扩展名）默认软换行，配合纵向滚动；
 *   - 代码类（.ts/.json/.py…）保持默认不换行，缩进对齐更可读；
 *   - 文档类（md/html/svg）与二进制预览不走代码换行判断。
 */
import { describe, expect, it } from 'vitest'
import { isPlainTextLikeSource } from '../src/zcode-ui/PreviewPane.tsx'

function file(path: string) {
  return { type: 'file', title: path, path } as never
}

describe('预览面板：纯文本默认软换行', () => {
  it('.txt / .log / 无扩展名 判定为纯文本', () => {
    expect(isPlainTextLikeSource(file('projects/洛神赋仕女/04-storyboard/segment1_0_10s.txt'))).toBe(true)
    expect(isPlainTextLikeSource(file('logs/gw.log'))).toBe(true)
    expect(isPlainTextLikeSource(file('notes/README'))).toBe(true)
  })

  it('代码类不判为纯文本（保留缩进对齐）', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.py', 'a.json', 'a.yaml', 'a.css', 'a.js', 'a.sql']) {
      expect(isPlainTextLikeSource(file(p)), p).toBe(false)
    }
  })

  it('文档与二进制预览不参与代码换行判断', () => {
    for (const p of ['doc.md', 'page.html', 'pic.png', 'doc.pdf', 'sheet.xlsx', 'deck.pptx']) {
      expect(isPlainTextLikeSource(file(p)), p).toBe(false)
    }
  })

  it('text 源只有 log 语言才算纯文本', () => {
    expect(
      isPlainTextLikeSource({ type: 'text', title: 't', content: 'x', language: 'log' } as never),
    ).toBe(true)
    expect(
      isPlainTextLikeSource({ type: 'text', title: 't', content: '{}', language: 'json' } as never),
    ).toBe(false)
  })

  it('非文件类源一律不判为纯文本', () => {
    expect(isPlainTextLikeSource(null)).toBe(false)
    expect(
      isPlainTextLikeSource({ type: 'patch', title: 'p', diff: '+-' } as never),
    ).toBe(false)
  })
})
