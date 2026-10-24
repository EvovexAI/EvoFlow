import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyTheme, replayThemeIntoBridgeRoots } from '../src/zcode-ui/useTheme.ts'
import { hostResolvedTheme, isBridgeDark } from '../src/zcode-ui/lib/bridgeTheme.ts'

function resetDom(): void {
  document.documentElement.className = ''
  document.documentElement.removeAttribute('data-theme')
  document.body.innerHTML = ''
}

beforeEach(resetDom)
afterEach(resetDom)

describe('zcode 主题在 EvoFlow 宿主里不得污染文档根', () => {
  it('bridge host: 只写 .zcode-bridge-root，不写 html.dark', () => {
    const shell = document.createElement('div')
    shell.className = 'chat-react-full'
    const bridge = document.createElement('div')
    bridge.className = 'zcode-bridge-root'
    shell.appendChild(bridge)
    document.body.appendChild(shell)

    applyTheme('zai-dark')

    // 关键回归断言：整站变黑的根因就是这里被写了 dark
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('theme-zai-dark')).toBe(false)
    // 宿主未声明 data-theme 时按浅色处理（zcode 的 zai-dark 默认值不生效）
    expect(bridge.classList.contains('theme-zai-light')).toBe(true)
  })

  it('bridge host: 宿主 light 时容器不留暗色类', () => {
    const bridge = document.createElement('div')
    bridge.className = 'zcode-bridge-root'
    document.body.appendChild(bridge)
    document.documentElement.dataset.theme = 'light'

    applyTheme('zai-dark')

    expect(bridge.classList.contains('dark')).toBe(false)
    expect(bridge.classList.contains('theme-zai-light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('bridge host: 宿主 dark 时容器拿到暗色', () => {
    const bridge = document.createElement('div')
    bridge.className = 'zcode-bridge-root'
    document.body.appendChild(bridge)
    document.documentElement.dataset.theme = 'dark'

    applyTheme('zai-light')

    expect(bridge.classList.contains('dark')).toBe(true)
    expect(hostResolvedTheme()).toBe('dark')
    expect(isBridgeDark(bridge)).toBe(true)
  })

  it('容器晚于 store 挂载：先不写文档根，挂载后重放补到容器', () => {
    // store 模块加载时：宿主已在，但桥接容器还没渲染
    const shell = document.createElement('div')
    shell.className = 'chat-react-full'
    document.body.appendChild(shell)
    document.documentElement.dataset.theme = 'dark'

    applyTheme('zai-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // 容器挂载后再重放
    const bridge = document.createElement('div')
    bridge.className = 'zcode-bridge-root'
    shell.appendChild(bridge)
    replayThemeIntoBridgeRoots('zai-dark')

    expect(bridge.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('独立 ZCode 页（无宿主标记）仍写文档根，行为不变', () => {
    applyTheme('zai-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('theme-zai-dark')).toBe(true)
  })
})
