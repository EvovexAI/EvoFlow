import { describe, expect, it } from 'vitest'
import {
  formatWebEmbedDisplayUrl,
  isLocalFileUrl,
  localUrlToFsPath,
  normalizeWebEmbedUserUrl,
  resolveWebEmbedSrc,
} from '../src/react/right-stage/web-embed-url.ts'

describe('web-embed-url', () => {
  it('detects local file URLs and paths', () => {
    expect(isLocalFileUrl('file:///D:/dev/a.html')).toBe(true)
    expect(isLocalFileUrl('D:\\dev\\a.html')).toBe(true)
    expect(isLocalFileUrl('/tmp/a.html')).toBe(true)
    expect(isLocalFileUrl('https://example.com')).toBe(false)
  })

  it('preserves file:// in normalizeWebEmbedUserUrl', () => {
    expect(normalizeWebEmbedUserUrl('file:///D:/docs/a.html')).toBe('file:///D:/docs/a.html')
    expect(normalizeWebEmbedUserUrl('D:\\docs\\a.html')).toBe('file:///D:/docs/a.html')
    expect(normalizeWebEmbedUserUrl('example.com/x')).toBe('https://example.com/x')
  })

  it('maps file:// to filesystem path', () => {
    const p = localUrlToFsPath('file:///D:/dev/github/EvoFlow/docs/a.html')
    expect(p.replace(/\\/g, '/').toLowerCase()).toBe('d:/dev/github/evoflow/docs/a.html')
  })

  it('formats local display paths', () => {
    expect(formatWebEmbedDisplayUrl('file:///D:/a/b.html').toLowerCase()).toContain('d:/a/b.html')
  })

  it('marks local files blocked without convertFileSrc', async () => {
    const r = await resolveWebEmbedSrc('file:///D:/a.html', { convertFileSrc: null })
    expect(r.localBlocked).toBe(true)
    expect(r.src).toBe('')
  })

  it('uses srcDoc for HTML via convertFileSrc + fetch', async () => {
    const convert = (path) => `https://asset.localhost/${encodeURIComponent(path)}`
    const prevFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response('<html><head></head><body>hi</body></html>', { status: 200 })
    try {
      const r = await resolveWebEmbedSrc('file:///D:/docs/outline.html', { convertFileSrc: convert })
      expect(r.localBlocked).toBeFalsy()
      expect(r.srcDoc).toContain('hi')
      expect(r.srcDoc).toMatch(/<base\s/i)
    } finally {
      globalThis.fetch = prevFetch
    }
  })
})
