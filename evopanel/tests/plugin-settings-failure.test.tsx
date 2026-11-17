/**
 * 设置中心 · 插件市场 Tab：网关不可用时不得「空白」
 *
 * 【self-evolution-bot · 2026-11-17 · 第35轮】首建。
 *
 * 真实日志证据（C:/Users/admin/.evoflow/logs/frontend-2026-11-17.log）：
 *   [2026-11-17 00:30:41] [ERROR] [boot:490c0476] [gateway_direct] GET /api/plugins/overview :: Not Found
 *   [2026-11-17 00:37:28] [ERROR] [boot:6c978505] [gateway_direct] GET /api/plugins/overview :: Failed to fetch
 * 即用户报「插件打开是空白」时，插件接口是失败的（网关那个版本没有 /api/plugins/* 路由）。
 *
 * 本用例钉住的契约：**接口失败时面板必须给出可见文案**，不能只剩空白让用户猜。
 * 空白面板等于把错误吞掉——这是本次报案的可复现内核。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'

vi.mock('../src/lib/tauri-api.js', () => ({
  gatewayProxy: async (_method: string, path: string) => {
    // 复刻真实 404 现场：网关没有该路由
    if (path.includes('/api/plugins/')) {
      const err = new Error('Not Found') as Error & { status?: number }
      err.status = 404
      throw err
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
})

describe('插件市场 Tab · 接口失败时必须给可见文案', () => {
  it('网关 404 时，容器里出现错误提示，而不是全空白', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    mountPluginManagementInto(container)
    await flush()

    const text = (container.textContent ?? '').trim()

    // 这条是本次报案的核心断言：失败场景下必须有字。
    expect(text.length, '接口 404 时面板完全没有文字＝用户看到空白').toBeGreaterThan(0)
    // 并且要能看出是「出错了」，不是伪装成正常空列表。
    expect(text).toMatch(/Not Found|失败|错误|重试|无法/)

    cleanup()
    container.remove()
  })
})
