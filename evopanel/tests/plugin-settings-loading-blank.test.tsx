/**
 * 设置中心 · 插件市场 Tab：接口长期不返回时不得「空白」
 *
 * 【self-evolution-bot · 2026-11-17 · 第35轮】首建。
 *
 * 现场证据（frontend-2026-11-17.log 19:53~19:54）：网关重启期间
 * `[gateway-watch] event=lost` 后，一批请求同时 `Failed to fetch`。
 * gatewayProxy 对可重试错误会带退避重试（数秒~数十秒），期间
 * pluginManagementStore.loading 一直为 true。
 *
 * 本用例钉住的契约：**加载期间必须有可见文字**。若列表视图在 loading 态
 * 只画一个纯 CSS 圆环（无文字），用户看到的就是一整块空白 —— 这正是
 * 「打开是空白，看不到内容」在无报错日志时的形态。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'

vi.mock('../src/lib/tauri-api.js', () => ({
  // 永远不 resolve：复刻网关重启窗口内请求挂住
  gatewayProxy: () => new Promise(() => {}),
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

describe('插件市场 Tab · 加载中必须给可见文字', () => {
  it('接口挂住时，容器里仍有可见文字，不是一整块空白', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const text = (container.textContent ?? '').replace(/\s+/g, '')

    expect(
      text.length,
      '接口挂住时面板没有任何文字＝用户看到纯空白，无法判断是在加载还是坏了',
    ).toBeGreaterThan(0)

    cleanup()
    container.remove()
  })
})
