/**
 * 设置中心 · 插件市场 Tab：子树渲染抛错时不得「静默空白」
 *
 * 【self-evolution-bot · 2026-11-17 · 第35轮】首建。
 *
 * 这是「空白」唯一能躲过所有日志与接口排查的路径：
 *   hub.js 用 `try { await mountPluginManagementInto(pane) } catch (e) { pane 显示加载失败 }`
 *   包住挂载，但 React 的渲染发生在 createRoot 之后，**渲染期抛错不会回到那个
 *   await 的 catch**。没有 ErrorBoundary 时 createRoot 会把整棵子树卸载 →
 *   面板只剩一个空 div = 用户看到纯空白，前端日志里一条插件记录都没有。
 *
 * 注入点选「被渲染的子组件本身」而不是某个 service 工厂：
 * 曾经用过 spyOn(createEvoflowSettingsSyncService) 抛错，但 accessor 已提到模块级
 * 常量，spy 挂上时它早就算完了 → 异常从没发生 → 拆掉 ErrorBoundary 测试照样绿
 * （假绿）。组件级 mock 才真正落在渲染期。
 *
 * 反证：把 plugin-management.tsx 里的 PluginBridgeErrorBoundary 摘掉，本用例必须变红。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import overviewFixture from './fixtures/plugins-overview.json'
import listFixture from './fixtures/plugins-list.json'

vi.mock('../src/lib/tauri-api.js', () => ({
  gatewayProxy: async (_method: string, path: string) => {
    if (path.includes('/api/plugins/overview')) return structuredClone(overviewFixture)
    if (path.includes('/api/plugins/list')) return structuredClone(listFixture)
    return {}
  },
  isTauri: false,
}))

// 让真正被渲染的商店页在渲染期抛错（模拟某 hook 拿到意外 undefined）。
vi.mock('../src/zcode-ui/settings/PluginStorePage.js', () => ({
  PluginStorePage: () => {
    throw new Error('boom: plugin store page render crash')
  },
}))

const { mountPluginManagementInto, cleanup } = await import(
  '../src/pages/settings/plugin-management.tsx'
)

function flush(times = 20): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)))
  }
  return p
}

const origError = console.error
afterEach(() => {
  cleanup()
  console.error = origError
})

describe('插件市场 Tab · 子树抛错时必须给可见文案', () => {
  it('商店页渲染抛错时，容器里出现失败提示而不是纯空白', async () => {
    console.error = () => {}

    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const text = (container.textContent ?? '').trim()

    expect(
      text.length,
      '渲染抛错后容器完全没有文字＝用户看到纯空白，且前端日志无插件记录',
    ).toBeGreaterThan(0)
    expect(text).toContain('插件面板加载失败')
    expect(text).toContain('boom: plugin store page render crash')

    cleanup()
    container.remove()
  })
})
