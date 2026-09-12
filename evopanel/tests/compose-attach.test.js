/**
 * Shared compose-attach parsing (path / URL / blob).
 */
import { describe, expect, it } from 'vitest'
import {
  EVO_WORKSPACE_PATH_MIME,
  appendUrlsToDraft,
  composeAttachDragOver,
  createComposeAttachHandlers,
  looksLikeLocalPath,
  normalizeLocalPath,
  parseComposeDataTransfer,
} from '../src/react/lib/compose-attach.js'

function mockDataTransfer(partial) {
  const data = partial.data || {}
  return {
    files: partial.files || [],
    items: [],
    types: Object.keys(data),
    getData: (type) => data[type] || '',
    setData: () => {},
    clearData: () => {},
    setDragImage: () => {},
    dropEffect: 'none',
    effectAllowed: 'all',
  }
}

describe('compose-attach', () => {
  it('detects local paths', () => {
    expect(looksLikeLocalPath('C:\\Users\\a\\b.png')).toBe(true)
    expect(looksLikeLocalPath('/tmp/a.txt')).toBe(true)
    expect(looksLikeLocalPath('https://example.com/a.png')).toBe(false)
  })

  it('normalizes file:// URLs', () => {
    const p = normalizeLocalPath('file:///C:/Users/a/b.txt')
    expect(p.toLowerCase().replace(/\\/g, '/')).toContain('c:/users/a/b.txt')
  })

  it('parses workspace mime without re-upload', () => {
    const dt = mockDataTransfer({
      data: {
        [EVO_WORKSPACE_PATH_MIME]: JSON.stringify([{ path: 'D:/proj/src/a.ts', name: 'a.ts' }]),
      },
    })
    const result = parseComposeDataTransfer(dt)
    expect(result.handled).toBe(true)
    expect(result.contextFiles).toEqual([{ path: 'D:/proj/src/a.ts', name: 'a.ts' }])
    expect(result.blobFiles).toEqual([])
  })

  it('pastes lone http URL without handling', () => {
    const dt = mockDataTransfer({
      data: { 'text/plain': 'https://example.com/docs' },
    })
    const result = parseComposeDataTransfer(dt, { fromPaste: true })
    expect(result.handled).toBe(false)
  })

  it('drop http URL is handled for insert', () => {
    const dt = mockDataTransfer({
      data: { 'text/uri-list': 'https://example.com/docs' },
    })
    const result = parseComposeDataTransfer(dt, { fromPaste: false })
    expect(result.handled).toBe(true)
    expect(result.urls).toContain('https://example.com/docs')
  })

  it('does not treat Chinese task text as a local path', () => {
    expect(looksLikeLocalPath('/api/users 帮我看看')).toBe(false)
    expect(looksLikeLocalPath('帮我写一份周报')).toBe(false)
  })

  it('parses dropped files with native path as context (no upload)', () => {
    const file = { name: 'a.txt', size: 12, lastModified: 1, path: 'D:\\proj\\a.txt' }
    const dt = mockDataTransfer({ files: [file] })
    const result = parseComposeDataTransfer(dt, { fromPaste: false })
    expect(result.handled).toBe(true)
    expect(result.contextFiles).toEqual([{ path: 'D:\\proj\\a.txt', name: 'a.txt' }])
    expect(result.blobFiles).toEqual([])
  })

  it('composeAttachDragOver accepts file drops', () => {
    const prevented = []
    composeAttachDragOver({
      preventDefault: () => prevented.push('yes'),
      dataTransfer: { types: ['Files'] },
    })
    expect(prevented).toEqual(['yes'])
  })

  it('appendUrlsToDraft dedupes', () => {
    expect(appendUrlsToDraft('hello\nhttps://a.com', ['https://a.com', 'https://b.com'])).toBe(
      'hello\nhttps://a.com\nhttps://b.com',
    )
  })

  it('paste plain text syncs into controlled field (no native DOM insert)', () => {
    let synced = ''
    const { handlePaste } = createComposeAttachHandlers({
      onContextFiles: () => {},
      onBlobFiles: () => {},
      onUnhandledPasteSync: (v) => {
        synced = v
      },
    })
    const prevented = []
    handlePaste({
      clipboardData: mockDataTransfer({ data: { 'text/plain': 'hello world' } }),
      preventDefault: () => prevented.push(true),
      currentTarget: { value: '', selectionStart: 0, selectionEnd: 0 },
    })
    expect(prevented).toEqual([true])
    expect(synced).toBe('hello world')
  })

  it('paste plain text at caret in controlled field', () => {
    let synced = ''
    const { handlePaste } = createComposeAttachHandlers({
      onContextFiles: () => {},
      onBlobFiles: () => {},
      onUnhandledPasteSync: (v) => {
        synced = v
      },
    })
    handlePaste({
      clipboardData: mockDataTransfer({ data: { 'text/plain': ' there' } }),
      preventDefault: () => {},
      currentTarget: { value: 'hi', selectionStart: 2, selectionEnd: 2 },
    })
    expect(synced).toBe('hi there')
  })
})
