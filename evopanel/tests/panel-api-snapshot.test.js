/**
 * Main-panel snapshot refs for /main-cdp + platform ui.panel.
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectPanelSnapshot } from '../src/lib/panel-cdp/panel-snapshot.js'
import { createPanelApi, mountPanelApi } from '../src/lib/panel-cdp/panel-api.ts'

describe('panel snapshot + __evoflowPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <button id="send">发送</button>
        <input id="composer" type="text" placeholder="说点什么" value="" />
        <a href="#/chat">聊天</a>
        <div style="display:none"><button id="hidden">隐藏</button></div>
      </main>
    `
    // happy-dom 默认 getBoundingClientRect 常为 0×0，会被 isVisible 滤掉
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      if (this.id === 'hidden' || this.closest?.('[style*="display:none"]')) {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} }
      }
      return { x: 0, y: 0, width: 80, height: 24, top: 0, left: 0, right: 80, bottom: 24, toJSON() {} }
    })
  })

  it('assigns eN refs to interactive elements', () => {
    const snap = collectPanelSnapshot()
    expect(snap.elements.length).toBeGreaterThanOrEqual(3)
    expect(snap.elements[0].ref).toBe('e1')
    expect(snap._nodes.length).toBe(snap.elements.length)
    const names = snap.elements.map((e) => e.name || e.text)
    expect(names.some((n) => String(n).includes('发送'))).toBe(true)
  })

  it('excludes hidden interactive nodes by default', () => {
    const snap = collectPanelSnapshot()
    expect(snap.elements.some((e) => e.name === '隐藏' || e.text === '隐藏')).toBe(false)
    const withHidden = collectPanelSnapshot({ includeHidden: true })
    expect(withHidden.elements.length).toBeGreaterThanOrEqual(snap.elements.length)
  })

  it('mountPanelApi click/fill use snapshot refs', () => {
    const api = mountPanelApi(window)
    expect(window.__evoflowPanel).toBe(api)
    const snap = api.snapshot()
    expect(snap.ok).toBe(true)
    const btn = snap.result.elements.find((e) => e.role === 'button' && String(e.name || '').includes('发送'))
    expect(btn?.ref).toBeTruthy()
    const clicked = api.click(btn.ref)
    expect(clicked.ok).toBe(true)
    const input = snap.result.elements.find((e) => e.role === 'textbox')
    expect(input?.ref).toBeTruthy()
    const filled = api.fill(input.ref, 'hello')
    expect(filled.ok).toBe(true)
    expect(document.querySelector('#composer').value).toBe('hello')
  })

  it('stale ref returns ref_not_found', () => {
    const api = createPanelApi()
    const miss = api.click('e99')
    expect(miss.ok).toBe(false)
    expect(miss.code).toBe('ref_not_found')
  })
})
