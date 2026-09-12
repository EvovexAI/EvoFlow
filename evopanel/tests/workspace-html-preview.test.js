import { describe, expect, it } from 'vitest'
import { prepareHtmlSrcDocForPreview } from '../src/lib/workspace-html-preview.js'

describe('prepareHtmlSrcDocForPreview', () => {
  it('injects tailwind shim after <head>', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body></body></html>'
    const out = prepareHtmlSrcDocForPreview(html)
    expect(out).toContain('window.tailwind.config')
    expect(out.indexOf('window.tailwind.config')).toBeLessThan(out.indexOf('<title>'))
  })

  it('creates head when missing', () => {
    const html = '<html><body>hi</body></html>'
    const out = prepareHtmlSrcDocForPreview(html)
    expect(out).toMatch(/<head>[\s\S]*window\.tailwind\.config[\s\S]*<\/head>/)
  })

  it('prepends shim for fragment html', () => {
    const html = '<div>only</div>'
    const out = prepareHtmlSrcDocForPreview(html)
    expect(out.startsWith('<script>')).toBe(true)
    expect(out).toContain('window.tailwind.config')
  })

  it('is idempotent', () => {
    const html = '<html><head></head><body></body></html>'
    const once = prepareHtmlSrcDocForPreview(html)
    expect(prepareHtmlSrcDocForPreview(once)).toBe(once)
  })
})
