/**
 * 设置全屏弹窗：Tauri 无边框下必须有顶栏拖拽带，且不能整卡 no-drag。
 *
 * 回归：曾经对 .react-chat-modal-card 打 data-tauri-no-drag，卡片又 100vw×100vh，
 * 顶栏点击无法拖动窗口。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyFullscreenModalTauriDragChrome } from '../src/lib/modal-chrome.js'

describe('settings fullscreen tauri drag chrome', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.__TAURI_INTERNALS__ = {}
    vi.resetModules()
  })

  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    document.body.innerHTML = ''
  })

  it('marks top strip as drag region and does not no-drag the whole card', () => {
    const overlay = document.createElement('div')
    overlay.id = 'evopanel-settings-modal-overlay'
    overlay.innerHTML = `
      <div class="react-chat-modal-card react-chat-modal-card--settings" data-tauri-no-drag>
        <div class="settings-modal-tauri-drag" data-fullscreen-modal-drag></div>
        <button type="button" data-settings-modal-close>×</button>
        <div class="react-chat-modal-body"></div>
      </div>
    `
    document.body.appendChild(overlay)

    applyFullscreenModalTauriDragChrome(overlay)

    const card = overlay.querySelector('.react-chat-modal-card')
    const strip = overlay.querySelector('[data-fullscreen-modal-drag]')
    const close = overlay.querySelector('[data-settings-modal-close]')

    expect(overlay.hasAttribute('data-tauri-drag-region')).toBe(false)
    expect(card.hasAttribute('data-tauri-no-drag')).toBe(false)
    expect(strip.hasAttribute('data-tauri-drag-region')).toBe(true)
    expect(close.hasAttribute('data-tauri-no-drag')).toBe(true)
  })
})
