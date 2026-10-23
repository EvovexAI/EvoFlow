import { describe, expect, it } from 'vitest'
import {
  PREVIEW_DOC_CODE,
  PREVIEW_DOC_CSV,
  PREVIEW_DOC_HTML,
  PREVIEW_DOC_JSON,
  PREVIEW_DOC_MARKDOWN,
  PREVIEW_DOC_MERMAID,
  PREVIEW_DOC_SVG,
  canToggleSource,
  isCsvPreviewPath,
  isHtmlPreviewPath,
  isJsonPreviewPath,
  isMarkdownPreviewPath,
  isMermaidPreviewPath,
  isSvgPreviewPath,
  looksLikeHtmlContent,
  looksLikeMermaidContent,
  looksLikeSvgContent,
  previewDocKind,
  previewRenderLabel,
  resolvePreviewView,
} from '../src/lib/preview-view-mode.js'

describe('previewDocKind（按文件格式判定）', () => {
  it('keeps existing non-preview extensions as plain code', () => {
    expect(previewDocKind({ path: 'outputs/page.html', name: 'page.html', content: '<html></html>' })).toBe(
      PREVIEW_DOC_HTML,
    )
    expect(previewDocKind({ path: 'docs/report.html', name: 'report.html' })).toBe(PREVIEW_DOC_HTML)
    expect(previewDocKind({ path: 'outputs/README.md', name: 'README.md' })).toBe(PREVIEW_DOC_MARKDOWN)
    expect(previewDocKind({ path: 'docs/note.markdown' })).toBe(PREVIEW_DOC_MARKDOWN)
  })

  it('detects markdown/html from extension case-insensitively via name only', () => {
    expect(previewDocKind({ name: 'Plan.MDX' })).toBe(PREVIEW_DOC_MARKDOWN)
    expect(previewDocKind({ name: 'LANDING.HTM' })).toBe(PREVIEW_DOC_HTML)
  })

  it('markdown wins over html-looking content', () => {
    expect(previewDocKind({ path: 'docs/x.md', content: '<!DOCTYPE html><html></html>' })).toBe(
      PREVIEW_DOC_MARKDOWN,
    )
  })

  it('falls back to content sniffing when extension is missing (streaming write)', () => {
    expect(previewDocKind({ path: '', name: '', content: '<!DOCTYPE html>\n<html>' })).toBe(PREVIEW_DOC_HTML)
    expect(previewDocKind({ path: 'outputs/report', content: '  <html lang="zh">' })).toBe(PREVIEW_DOC_HTML)
  })

  it('treats everything else as code', () => {
    expect(previewDocKind({ path: 'a.py', content: 'print(1)' })).toBe(PREVIEW_DOC_CODE)
    expect(previewDocKind({ path: 'a.txt', content: 'hello' })).toBe(PREVIEW_DOC_CODE)
    expect(previewDocKind({})).toBe(PREVIEW_DOC_CODE)
  })
})

describe('isHtmlPreviewPath / isMarkdownPreviewPath / looksLikeHtmlContent', () => {
  it('matches html-ish extensions', () => {
    expect(isHtmlPreviewPath('a.html')).toBe(true)
    expect(isHtmlPreviewPath('dir/b.HTM')).toBe(true)
    expect(isHtmlPreviewPath('a.md')).toBe(false)
    expect(isHtmlPreviewPath('')).toBe(false)
  })

  it('matches markdown extensions', () => {
    expect(isMarkdownPreviewPath('a.md')).toBe(true)
    expect(isMarkdownPreviewPath('dir/口播稿.MARKDOWN')).toBe(true)
    expect(isMarkdownPreviewPath('a.html')).toBe(false)
  })

  it('sniffs html content only when it looks like a document', () => {
    expect(looksLikeHtmlContent('<!doctype html><html></html>')).toBe(true)
    expect(looksLikeHtmlContent('<html lang="zh">')).toBe(true)
    expect(looksLikeHtmlContent('<div>fragment</div>')).toBe(false)
    expect(looksLikeHtmlContent('   ')).toBe(false)
  })
})

describe('canToggleSource', () => {
  it('allows html & markdown only', () => {
    expect(canToggleSource(PREVIEW_DOC_HTML, {})).toBe(true)
    expect(canToggleSource(PREVIEW_DOC_MARKDOWN, {})).toBe(true)
    expect(canToggleSource(PREVIEW_DOC_CODE, {})).toBe(false)
  })

  it('blocks binary / error, and streaming html only', () => {
    expect(canToggleSource(PREVIEW_DOC_HTML, { binary: true })).toBe(false)
    expect(canToggleSource(PREVIEW_DOC_HTML, { error: 'boom' })).toBe(false)
    expect(canToggleSource(PREVIEW_DOC_HTML, { streaming: true })).toBe(false)
    // Markdown 流式仍可切换（渲染预览是原默认行为）
    expect(canToggleSource(PREVIEW_DOC_MARKDOWN, { streaming: true })).toBe(true)
  })
})

describe('resolvePreviewView', () => {
  it('defaults to render for html & markdown', () => {
    expect(resolvePreviewView(PREVIEW_DOC_HTML, 'preview')).toBe('render')
    expect(resolvePreviewView(PREVIEW_DOC_MARKDOWN, 'preview')).toBe('render')
    expect(resolvePreviewView(PREVIEW_DOC_CODE, 'preview')).toBe('source')
  })

  it('switches to source when code mode is chosen', () => {
    expect(resolvePreviewView(PREVIEW_DOC_HTML, 'code')).toBe('source')
    expect(resolvePreviewView(PREVIEW_DOC_MARKDOWN, 'code')).toBe('source')
  })

  it('forces source for in-flight html writes (previous behaviour kept)', () => {
    expect(resolvePreviewView(PREVIEW_DOC_HTML, 'preview', { streaming: true })).toBe('source')
  })
})

describe('新增可切换格式：SVG / JSON / CSV / Mermaid', () => {
  it('detects each format by extension', () => {
    expect(previewDocKind({ path: 'assets/logo.svg' })).toBe(PREVIEW_DOC_SVG)
    expect(previewDocKind({ path: 'data/report.json' })).toBe(PREVIEW_DOC_JSON)
    expect(previewDocKind({ path: 'data/report.JSONC' })).toBe(PREVIEW_DOC_JSON)
    expect(previewDocKind({ path: 'data/rows.csv' })).toBe(PREVIEW_DOC_CSV)
    expect(previewDocKind({ path: 'data/rows.tsv' })).toBe(PREVIEW_DOC_CSV)
    expect(previewDocKind({ path: 'diagram/flow.mmd' })).toBe(PREVIEW_DOC_MERMAID)
    expect(previewDocKind({ name: 'flow.mermaid' })).toBe(PREVIEW_DOC_MERMAID)
  })

  it('path extension wins over content sniffing', () => {
    expect(previewDocKind({ path: 'a.json', content: '<svg></svg>' })).toBe(PREVIEW_DOC_JSON)
    expect(previewDocKind({ path: 'a.md', content: '{"k":1}' })).toBe(PREVIEW_DOC_MARKDOWN)
  })

  it('sniffs svg / mermaid when path is unknown (streaming)', () => {
    expect(previewDocKind({ content: '<svg viewBox="0 0 10 10"></svg>' })).toBe(PREVIEW_DOC_SVG)
    expect(previewDocKind({ content: 'flowchart TD\n  A-->B' })).toBe(PREVIEW_DOC_MERMAID)
    expect(previewDocKind({ content: 'sequenceDiagram\n  A->>B: hi' })).toBe(PREVIEW_DOC_MERMAID)
  })

  it('extension helpers stay narrow', () => {
    expect(isSvgPreviewPath('a.svg')).toBe(true)
    expect(isSvgPreviewPath('a.png')).toBe(false)
    expect(isJsonPreviewPath('a.geojson')).toBe(true)
    expect(isCsvPreviewPath('a.csv')).toBe(true)
    expect(isCsvPreviewPath('a.xlsx')).toBe(false)
    expect(isMermaidPreviewPath('a.mmd')).toBe(true)
    expect(isMermaidPreviewPath('a.md')).toBe(false)
  })

  it('content sniffers ignore unrelated text', () => {
    expect(looksLikeSvgContent('<div>x</div>')).toBe(false)
    expect(looksLikeMermaidContent('hello world')).toBe(false)
    expect(looksLikeSvgContent('  <svg></svg>')).toBe(true)
  })

  it('all new formats are toggleable and render by default', () => {
    for (const kind of [
      PREVIEW_DOC_SVG,
      PREVIEW_DOC_JSON,
      PREVIEW_DOC_CSV,
      PREVIEW_DOC_MERMAID,
    ]) {
      expect(canToggleSource(kind, {})).toBe(true)
      expect(resolvePreviewView(kind, 'preview')).toBe('render')
      expect(resolvePreviewView(kind, 'code')).toBe('source')
    }
  })

  it('executes-nothing-until-rendered formats stay source while streaming', () => {
    for (const kind of [PREVIEW_DOC_SVG, PREVIEW_DOC_MERMAID]) {
      expect(canToggleSource(kind, { streaming: true })).toBe(false)
      expect(resolvePreviewView(kind, 'preview', { streaming: true })).toBe('source')
    }
    // JSON / CSV 流式仍可切换
    expect(canToggleSource(PREVIEW_DOC_JSON, { streaming: true })).toBe(true)
    expect(canToggleSource(PREVIEW_DOC_CSV, { streaming: true })).toBe(true)
  })

  it('gives format-specific toggle labels', () => {
    expect(previewRenderLabel(PREVIEW_DOC_MARKDOWN)).toBe('预览')
    expect(previewRenderLabel(PREVIEW_DOC_CSV)).toBe('表格')
    expect(previewRenderLabel(PREVIEW_DOC_JSON)).toBe('格式化')
    expect(previewRenderLabel(PREVIEW_DOC_MERMAID)).toBe('图表')
    expect(previewRenderLabel(PREVIEW_DOC_SVG)).toBe('渲染')
    expect(previewRenderLabel(PREVIEW_DOC_HTML)).toBe('渲染')
    expect(previewRenderLabel(PREVIEW_DOC_CODE)).toBe('渲染')
  })
})
