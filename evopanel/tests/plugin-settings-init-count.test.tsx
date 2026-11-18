/**
 * 设置中心 · 插件市场 Tab：initialize 不得因渲染而重复触发
 *
 * 【self-evolution-bot · 2026-11-17 · 第35轮】首建。
 *
 * 待证缺陷：EvoflowPluginApp 里 `const services = createEvoflowServiceAccessor()`
 * 写在组件体内，而 `useEffect(..., [services])` 以它为依赖。每次渲染都新建
 * 一个对象 → effect 每次渲染都重跑 → 再 setState → 再渲染 …… 形成自激循环，
 * 表现为面板一直转圈 / 反复打接口，用户看到的就是「打开是空白，看不到内容」。
 *
 * 判据取「网关请求次数」而不是「渲染了几次」：请求次数是可观测的副作用，
 * 与实现细节无关（换 hook 写法也照样成立）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import overviewFixture from './fixtures/plugins-overview.json'
import listFixture from './fixtures/plugins-list.json'

const calls: string[] = []

vi.mock('../src/lib/tauri-api.js', () => ({
  gatewayProxy: async (_method: string, path: string) => {
    calls.push(path)
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

function flush(times = 20): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)))
  }
  return p
}

afterEach(() => {
  cleanup()
  calls.length = 0
})

describe('插件市场 Tab · 初始化只跑一次', () => {
  it('挂载 + 静置后，插件接口请求次数必须是常数（overview + list 各一次）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const listCalls = calls.filter((p) => p.includes('/api/plugins/list')).length
    const overviewCalls = calls.filter((p) => p.includes('/api/plugins/overview')).length

    // 自激循环下这两个数字会随轮次线性增长（实测会到十几、几十）。
    // 正常应为 1 次；给 2 的余量以容忍 React 严格模式的双调用，
    // 但绝不允许「每渲染一次打一次」。
    expect(listCalls, `plugins/list 被打了 ${listCalls} 次，疑似 effect 自激`).toBeLessThanOrEqual(2)
    expect(overviewCalls, `plugins/overview 被打了 ${overviewCalls} 次，疑似 effect 自激`).toBeLessThanOrEqual(2)

    cleanup()
    container.remove()
  })
})
