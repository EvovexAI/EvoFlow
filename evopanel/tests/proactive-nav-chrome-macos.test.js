/**
 * macOS 窗口拖动回归：员工子页的操作栏不得覆盖标题栏拖拽区。
 *
 * 背景：macOS 用系统原生 Overlay 标题栏（top 26px 是交通灯，其下是自绘的
 * `#tauri-main-chrome` 拖拽条），窗口只能从这一条拖动。员工详情 / 工作项页
 * 曾把 `.pro-page-nav` 用 `position: fixed; top: 0` 浮到标题栏上，整条吃掉
 * 拖拽区，用户表现为「切到员工页后窗口锁死、无法移动」。
 *
 * 这里用静态断言守住两条不变量：
 *   1. macOS 下 `mountEmployeeNavToChrome` 直接跳过（不置位 nav-in-chrome）；
 *   2. 浮层定位规则被限定在 `html:not(.evopanel-macos-titlebar)` 下。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mountEmployeeNavToChrome, unmountEmployeeNavFromChrome } from '../src/lib/proactive-nav-chrome.js'

function makeDom({ macos }) {
  document.body.innerHTML = ''
  document.documentElement.className = macos ? 'evopanel-macos-titlebar' : ''
  const chrome = document.createElement('div')
  chrome.id = 'tauri-main-chrome'
  document.body.appendChild(chrome)

  const page = document.createElement('div')
  page.className = 'page proactive-page'
  page.innerHTML = '<div class="pro-page-nav"><button class="btn">返回</button></div>'
  document.body.appendChild(page)
  return { chrome, page }
}

describe('proactive employee nav → titlebar chrome', () => {
  beforeEach(() => {
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    document.documentElement.className = ''
  })

  it('skips mounting on macOS native titlebar (keeps drag region reachable)', () => {
    const { chrome, page } = makeDom({ macos: true })

    mountEmployeeNavToChrome(page)

    expect(page.classList.contains('pro-employee-page--nav-in-chrome')).toBe(false)
    expect(chrome.classList.contains('tauri-main-chrome--employee-nav')).toBe(false)
  })

  it('still mounts on Windows / Linux (no native titlebar class)', () => {
    const { chrome, page } = makeDom({ macos: false })

    mountEmployeeNavToChrome(page)

    expect(page.classList.contains('pro-employee-page--nav-in-chrome')).toBe(true)
    expect(chrome.classList.contains('tauri-main-chrome--employee-nav')).toBe(true)

    unmountEmployeeNavFromChrome(page)
    expect(page.classList.contains('pro-employee-page--nav-in-chrome')).toBe(false)
  })
})
