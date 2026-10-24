import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isBridgeDark, hostResolvedTheme } from '../src/zcode-ui/lib/bridgeTheme.js'

/**
 * 回归：EvoFlow 用 <html data-theme> 管明暗，从不往 <html> 写 dark 类。
 * 桥接容器（.zcode-bridge-root）同理只有 class，没有 data-theme。
 * 以前 isBridgeDark() 只看 classList，于是恒判 light：
 * shiki 输出 github-light 配色，容器背景却是暗色 token → 代码发白看不清。
 */
describe('bridge theme resolution', () => {
  beforeEach(() => {
    document.documentElement.className = ''
    delete (document.documentElement as HTMLElement).dataset.theme
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountBridgeRoot(opts: { className?: string; theme?: string } = {}) {
    const root = document.createElement('div')
    root.className = `zcode-bridge-root ${opts.className || ''}`.trim()
    if (opts.theme) root.dataset.theme = opts.theme
    const code = document.createElement('pre')
    root.appendChild(code)
    document.body.appendChild(root)
    return { root, code }
  }

  it('follows the host data-theme when the container has no theme class', () => {
    document.documentElement.dataset.theme = 'dark'
    const { code } = mountBridgeRoot()
    // 关键回归点：容器没有 dark 类，但宿主是暗色 → 必须判暗。
    expect(isBridgeDark(code)).toBe(true)
  })

  it('follows a light host too', () => {
    document.documentElement.dataset.theme = 'light'
    const { code } = mountBridgeRoot()
    expect(isBridgeDark(code)).toBe(false)
  })

  it('prefers an explicit class on the container over the host theme', () => {
    document.documentElement.dataset.theme = 'light'
    const { code } = mountBridgeRoot({ className: 'dark' })
    expect(isBridgeDark(code)).toBe(true)
    // zai-dark 是 zcode 的等价暗色类
    const second = mountBridgeRoot({ className: 'theme-zai-dark' })
    expect(isBridgeDark(second.code)).toBe(true)
  })

  it('uses the nearest container in scope rather than the first one', () => {
    document.documentElement.dataset.theme = 'light'
    mountBridgeRoot({ className: 'dark' })
    const second = mountBridgeRoot()
    // 第一个容器是 dark，但第二个容器范围内应跟随宿主 light。
    expect(isBridgeDark(second.code)).toBe(false)
  })

  it('reports host theme from data-theme', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(hostResolvedTheme()).toBe('dark')
    document.documentElement.dataset.theme = 'light'
    expect(hostResolvedTheme()).toBe('light')
  })
})

describe('resolveTheme honours the host in bridge mode', () => {
  beforeEach(() => {
    document.documentElement.className = ''
    delete (document.documentElement as HTMLElement).dataset.theme
    document.body.innerHTML = ''
  })

  function mountHostShell(theme: 'dark' | 'light', zcodeStoreTheme: 'zai-dark' | 'zai-light') {
    document.documentElement.dataset.theme = theme
    const shell = document.createElement('div')
    shell.className = 'zcode-bridge-root'
    document.body.appendChild(shell)
    return zcodeStoreTheme
  }

  it('uses the host theme, not the zcode store preference', async () => {
    const { resolveTheme } = await import('../src/zcode-ui/useTheme.js')
    // 宿主浅色 + store 默认 zai-dark → 必须解析成 light，
    // 否则右侧代码块会用暗色配色贴在浅色面板上。
    mountHostShell('light', 'zai-dark')
    expect(resolveTheme('zai-dark')).toBe('light')

    document.documentElement.dataset.theme = 'dark'
    expect(resolveTheme('zai-light')).toBe('dark')
  })

  it('prefers an explicit host theme passed by the subscriber', async () => {
    const { resolveTheme } = await import('../src/zcode-ui/useTheme.js')
    mountHostShell('dark', 'zai-dark')
    // useHostResolvedTheme 已算好值时不再重复查 DOM。
    expect(resolveTheme('zai-light', 'light')).toBe('light')
    expect(resolveTheme('zai-dark', 'dark')).toBe('dark')
  })
})
