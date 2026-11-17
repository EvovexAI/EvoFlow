/**
 * 设置中心 → 插件市场 Tab：真实渲染回归
 *
 * 用户报「插件打开是空白，看不到内容」。判据不能是「CSS 有没有规则」这类
 * 间接推断，必须是：把 hub.js 真正挂载的那棵树（mountPluginManagementInto）
 * 在 DOM 上跑起来，喂进**网关真实返回**的快照，然后断言插件名出现在可视文本里。
 *
 * 快照来源：http://127.0.0.1:8382/api/plugins/{overview,list} 的真实响应，
 * 落盘在 tests/fixtures/plugins-{overview,list}.json（9 个插件）。
 *
 * 【self-evolution-bot · 2026-11-17 · 第35轮】首建。
 * 反证方式：把 plugin-management.tsx 里挂载容器的 min-height 删掉/或把
 * initialize 的 workspacePath 去掉，本文件应当变红；否则说明它测不到真问题。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import overviewFixture from './fixtures/plugins-overview.json'
import listFixture from './fixtures/plugins-list.json'

// 插件客户端走 gatewayProxy（Tauri Rust / web fetch）；测试里替换成快照回放，
// 这样被断言的就是「组件在真实数据下渲染出什么」，而不是 mock 出来的假数据。
vi.mock('../src/lib/tauri-api.js', () => ({
  gatewayProxy: async (_method: string, path: string) => {
    if (path.includes('/api/plugins/overview')) return structuredClone(overviewFixture)
    if (path.includes('/api/plugins/list')) return structuredClone(listFixture)
    if (path.includes('/api/plugins/reference-catalog')) {
      return { entries: [], diagnostics: [] }
    }
    return {}
  },
  isTauri: false,
}))

const { mountPluginManagementInto, cleanup } = await import(
  '../src/pages/settings/plugin-management.tsx'
)

function flush(times = 12): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)))
  }
  return p
}

afterEach(() => {
  cleanup()
})

describe('设置中心 · 插件市场 Tab 挂载后不得空白', () => {
  it('用网关真实快照渲染，容器里出现插件名而不是空壳', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const text = container.textContent ?? ''
    // 空白 = textContent 只有空白字符。先证「不是空白」这个最基本的事实。
    expect(text.trim().length).toBeGreaterThan(0)
    // 再证「是插件内容」，不是加载占位/报错文案。
    expect(text).toContain('browser-use')
    expect(text).not.toMatch(/加载失败|Failed to fetch|Not Found/)

    cleanup()
    container.remove()
  })

  it('挂载容器有可测量的高度样式，不会被父级 flex 塌成 0', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const host = container.querySelector('.zcode-bridge-root') as HTMLElement | null
    expect(host).toBeTruthy()
    // hub.js 给 pane 的 class 决定了它能否撑开：插件面板必须命中宽/高撑满规则，
    // 否则在 .settings-modal-pane 的 flex 列里塌成 0 高 = 视觉空白。
    expect(host!.style.minHeight).toBe('400px')

    cleanup()
    container.remove()
  })
})
