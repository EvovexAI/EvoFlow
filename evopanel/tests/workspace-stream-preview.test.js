import { describe, expect, it } from 'vitest'
import {
  detectStreamingWritePreview,
  isStreamWriteContentDisplayable,
  isStreamAutoPreviewPath,
} from '../src/lib/workspace-preview-path.js'
import { mergeStreamingToolCallArgStrings } from '../src/lib/chat-normalize.js'

describe('mergeStreamingToolCallArgStrings', () => {
  it('concatenates non-prefix JSON chunks from tool_call_chunk', () => {
    const merged = mergeStreamingToolCallArgStrings('{"path":"out.txt","content":"hel', 'lo world"}')
    expect(merged).toBe('{"path":"out.txt","content":"hello world"}')
  })

  it('matches LangGraph evf sequence: empty args then "{" fragment', () => {
    let args = mergeStreamingToolCallArgStrings('', '')
    args = mergeStreamingToolCallArgStrings(args, '{')
    expect(args).toBe('{')
    args = mergeStreamingToolCallArgStrings(args, '"path":"outputs/a.txt","content":"hi')
    expect(args).toContain('outputs/a.txt')
    expect(args).toContain('"hi')
  })
})

describe('workspace stream auto preview', () => {
  it('auto-opens side panel only for html extensions', () => {
    expect(isStreamAutoPreviewPath('outputs/report.html')).toBe(true)
    expect(isStreamAutoPreviewPath('outputs/page.htm')).toBe(true)
    expect(isStreamAutoPreviewPath('outputs/doc.docx')).toBe(false)
    expect(isStreamAutoPreviewPath('outputs/legacy.doc')).toBe(false)
    expect(isStreamAutoPreviewPath('outputs/readme.md')).toBe(false)
    expect(isStreamAutoPreviewPath('outputs/notes.txt')).toBe(false)
    expect(isStreamAutoPreviewPath('outputs/app.ts')).toBe(false)
    expect(isStreamAutoPreviewPath('outputs/image.png')).toBe(false)
  })

  it('does not detect in-flight txt write for auto side panel', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        input: { path: 'outputs/notes.txt', content: 'hello world from values' },
        function: {
          name: 'write_to_file',
          arguments: '{"path":"outputs/notes.txt","content":"hello wo',
        },
      },
    ]
    expect(detectStreamingWritePreview(tools, { requireReady: false })).toBeNull()
  })

  it('ignores in-flight write tools for non-previewable paths', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        input: { path: 'outputs/binary.exe', content: 'MZ' },
      },
    ]
    expect(detectStreamingWritePreview(tools, { requireReady: false })).toBeNull()
  })

  it('detects in-flight html write from arguments fragments only', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        input: {
          path: 'outputs/page.html',
          content: '<html><body><h1>Full page</h1></body></html>',
        },
        function: {
          name: 'write_to_file',
          arguments: '{"path":"outputs/page.html","content":"<html><body><h1>Hi',
        },
      },
    ]
    const hit = detectStreamingWritePreview(tools, { requireReady: false })
    expect(hit?.path).toBe('outputs/page.html')
    expect(hit?.content).toBe('<html><body><h1>Hi')
    expect(hit?.streaming).toBe(true)
  })

  it('shows txt stream body as soon as content is readable', () => {
    expect(
      isStreamWriteContentDisplayable({
        path: 'outputs/notes.txt',
        content: 'hello',
        streaming: true,
      }),
    ).toBe(true)
  })

  it('stream preview ignores values snapshot input.content while tool in flight', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        input: {
          path: 'outputs/page.html',
          content: '<html><body><h1>COMPLETE FROM VALUES</h1></body></html>',
        },
        function: {
          name: 'write_to_file',
          arguments: '{"path":"outputs/page.html","content":"<html><body><h1>Hi',
        },
      },
    ]
    const hit = detectStreamingWritePreview(tools, { requireReady: false })
    expect(hit?.content).toBe('<html><body><h1>Hi')
    expect(hit?.content).not.toContain('COMPLETE FROM VALUES')
  })

  it('detects in-flight txt write from parsed input when not streaming', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'ok',
        input: { path: 'outputs/notes.txt', content: 'hello world' },
      },
    ]
    expect(detectStreamingWritePreview(tools, { requireReady: false })).toBeNull()
  })

  it('does not detect partial function.arguments stream for txt write', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        function: {
          name: 'write_to_file',
          arguments: '{"path":"outputs/notes.txt","content":"hello wo',
        },
      },
    ]
    expect(detectStreamingWritePreview(tools, { requireReady: false })).toBeNull()
  })

  it('shows html stream body early once angle bracket appears', () => {
    expect(
      isStreamWriteContentDisplayable({
        path: 'outputs/page.html',
        content: '<htm',
        streaming: true,
      }),
    ).toBe(true)
  })

  it('detects content-before-path html write from LangGraph chunk order', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        function: {
          name: 'write_to_file',
          arguments: '{"content":"<!DOCTYPE html\\n<html',
        },
      },
    ]
    const hit = detectStreamingWritePreview(tools, { requireReady: false })
    expect(hit?.path).toBe('')
    expect(hit?.name).toBe('生成 HTML…')
    expect(hit?.content).toContain('<!DOCTYPE')
    expect(
      isStreamWriteContentDisplayable({
        path: hit?.path || '',
        content: hit?.content || '',
        streaming: true,
      }),
    ).toBe(true)
  })

  it('binds path when it arrives after content in arguments stream', () => {
    const tools = [
      {
        name: 'write_to_file',
        status: 'running',
        function: {
          name: 'write_to_file',
          arguments:
            '{"content":"<html><body>Hi","path":"outputs/page.html"',
        },
      },
    ]
    const hit = detectStreamingWritePreview(tools, { requireReady: false })
    expect(hit?.path).toBe('outputs/page.html')
    expect(hit?.content).toBe('<html><body>Hi')
  })
})
