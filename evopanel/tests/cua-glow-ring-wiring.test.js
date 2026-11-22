// 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
//
// 锁一件事：**四周蓝光环必须真的被调用**。
//
// 背景（真实现网缺陷）：`cua_glow_ring_show/hide` 早已注册进 `lib.rs`、
// `cargo check` 全绿，但前端一次都没 invoke 过 —— 用户反馈「没有蓝光」，
// 不是画得不像，是**压根没被调用**。静态检查（node --check / tsc）对这种
// 「注册了但没人调」的缺陷零分辨力，所以这里必须有行为级断言。
//
// 判据：用假的 invoke 记录调用序列，断言 show/hide 成对出现、且与顶部卡片同生共死。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoked = []

// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
// 必须把实现**具名**留一份。原来某条用例写 `const realInvoke = core.invoke` 再
// `mockImplementation(realInvoke)` —— 而 core.invoke 本身就是 mock，于是 mock 调用自己，
// 无限递归并彻底弄坏后续用例（表现：后 3 条 invoked 恒为空，单跑却绿）。
const defaultImpl = async (cmd) => {
  invoked.push(cmd)
  // cua_glow_overlay_step 返回 true 表示「窗口已亮，进度已应用」
  if (cmd === 'cua_glow_overlay_step') return true
  return undefined
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(defaultImpl),
}))

async function loadModule() {
  // isTauri 在模块加载时取值，必须先把桥注入再 import。
  globalThis.window = globalThis.window || {}
  globalThis.window.__TAURI_INTERNALS__ = {}
  vi.resetModules()
  return import('../src/lib/cua-glow-overlay.js')
}

describe('cua 蓝光环接线', () => {
  beforeEach(() => {
    invoked.length = 0
    // 【self-evolution-bot · 2026-11-19 · 第72轮】测试卫生（不是生产缺陷）：
    // SHOW_LOCK 挂在 window.__evoFlowCuaGlowShow 上，vi.resetModules() 清不掉它 ——
    // 上一个用例若留下 in-flight，下一个用例的 showNative 会直接 await 一个旧 promise
    // 而不再 invoke，表现为 invoked 为空、整组里只有个别用例红（单跑却绿）。
    if (globalThis.window) {
      delete globalThis.window.__evoFlowCuaGlowShow
      delete globalThis.window.__evoflowCuaGlowPoll
    }
  })

  it('亮卡片时必须同时亮四周蓝光环', async () => {
    const mod = await loadModule()
    mod.beginCuaGlowOverlay('call-1')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_show'))
    expect(invoked).toContain('cua_glow_overlay_show')
  })

  it('强制隐藏时必须同时收掉蓝光环（用户点「解除控制」走这条）', async () => {
    const mod = await loadModule()
    mod.beginCuaGlowOverlay('call-2')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_show'))
    await mod.hideCuaGlowOverlayForced()
    expect(invoked).toContain('cua_glow_ring_hide')
    expect(invoked).toContain('cua_glow_overlay_hide')
  })

  it('引用计数归零（endCuaGlowOverlay）也要收掉蓝光环，不能留环亮着', async () => {
    const mod = await loadModule()
    mod.beginCuaGlowOverlay('call-3')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_show'))
    invoked.length = 0
    mod.endCuaGlowOverlay('call-3')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_hide'))
  })

  // 【self-evolution-bot · 2026-11-19 · 第71轮】现网真实缺陷回归：
  // 顶部卡片 show 一直失败（hwnd timeout / label already exists），
  // 原来 showRing() 写在它之后 ⇒ 抛异常跳 catch ⇒ 环一次都没起来。
  // 判据：卡片挂了，环必须照样亮。
  it('顶部卡片失败时，蓝光环仍然要亮', async () => {
    globalThis.window.__TAURI_INTERNALS__ = {}
    vi.resetModules()
    const mod = await import('../src/lib/cua-glow-overlay.js')

    // 让 overlay_show 抛错，模拟现网 hwnd timeout / label already exists
    const core = await import('@tauri-apps/api/core')
    core.invoke.mockImplementationOnce(async (cmd) => {
      invoked.push(cmd)
      if (cmd === 'cua_glow_overlay_show') {
        throw new Error('CUA indicator hwnd timeout: the underlying handle is not available')
      }
      return true
    })

    mod.beginCuaGlowOverlay('call-fail')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_show'))
    // 【self-evolution-bot · 2026-11-19 · 第72轮】恢复用**具名实现**，不能 core.invoke 自引用
    core.invoke.mockImplementation(defaultImpl)
  })

  it('重复 begin 不会重复起环线程（幂等）', async () => {
    const mod = await loadModule()
    mod.beginCuaGlowOverlay('call-4')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_ring_show'))
    const first = invoked.filter((c) => c === 'cua_glow_ring_show').length
    mod.beginCuaGlowOverlay('call-5')
    await new Promise((r) => setTimeout(r, 50))
    const second = invoked.filter((c) => c === 'cua_glow_ring_show').length
    expect(second).toBe(first)
  })

  it('已亮时再 begin 不得再调 overlay_show（否则每秒闪一下）', async () => {
    const mod = await loadModule()
    const core = await import('@tauri-apps/api/core')
    mod.beginCuaGlowOverlay('no-flash-1')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_overlay_show'))
    const shows = () =>
      core.invoke.mock.calls.filter(([c]) => c === 'cua_glow_overlay_show').length
    const before = shows()
    mod.beginCuaGlowOverlay('no-flash-2')
    await new Promise((r) => setTimeout(r, 80))
    expect(shows()).toBe(before)
  })
})

// 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
// 用户要「时长」。这一组锁的是**接线**而不是格式化：
// `push_overlay_step` 支持 elapsed/running、卡片也会走秒，
// 但前端 invoke 不传就等于全都没接上（我上一轮刚在 title 上栽过一次同型缺陷）。
// 判据：看真正发给 Rust 的实参，而不是模块内部变量。
describe('cua 提示条时长接线', () => {
  beforeEach(() => {
    invoked.length = 0
    // 同上：清掉跨模块残留的 show 锁，否则 showNative 会 await 旧 promise 而不 invoke。
    if (globalThis.window) {
      delete globalThis.window.__evoFlowCuaGlowShow
      delete globalThis.window.__evoflowCuaGlowPoll
    }
  })

  it('推步骤时必须同时带上时长与秒表状态', async () => {
    const mod = await loadModule()
    const core = await import('@tauri-apps/api/core')
    core.invoke.mockClear()
    // 先让窗口处于「已亮」状态，否则 updateCuaGlowStep 会去走 showNative
    mod.beginCuaGlowOverlay('elapsed-1')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_overlay_show'))
    core.invoke.mockClear()

    mod.updateCuaGlowStep('正在点击', 3, 65000, true)
    await vi.waitFor(() =>
      expect(
        core.invoke.mock.calls.some(([c]) => c === 'cua_glow_overlay_step'),
      ).toBe(true),
    )
    const stepCalls = core.invoke.mock.calls.filter(([c]) => c === 'cua_glow_overlay_step')
    const args = stepCalls.at(-1)[1]
    expect(args).toMatchObject({ step: '正在点击', stepsDone: 3, elapsedMs: 65000, running: true })
  })

  it('秒表停表（running=false）必须推一次，否则「已停止还在跳秒」', async () => {
    const mod = await loadModule()
    const core = await import('@tauri-apps/api/core')
    mod.beginCuaGlowOverlay('elapsed-2')
    await vi.waitFor(() => expect(invoked).toContain('cua_glow_overlay_show'))

    // 步骤没变、步数没变，只有秒表状态翻转 —— 这一推不能因为「文案没变」被早退吃掉
    mod.updateCuaGlowStep('正在点击', 3, 65000, true)
    // 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
    // 原来等的是「任意一次 invoke」——而 updateCuaGlowStep 内部是 `void (async …)`，
    // 这一次推送可能晚于 mockClear() 才落地，于是下一步取到的是上一条留下的
    // running:true，断言假红。必须等到**那一次 step 推送**真落地再清。
    await vi.waitFor(() =>
      expect(core.invoke.mock.calls.some(([c]) => c === 'cua_glow_overlay_step')).toBe(true),
    )
    await new Promise((r) => setTimeout(r, 20))
    core.invoke.mockClear()

    mod.updateCuaGlowStep('正在点击', 3, 65000, false)
    await vi.waitFor(() =>
      expect(
        core.invoke.mock.calls.some(([c]) => c === 'cua_glow_overlay_step'),
      ).toBe(true),
    )
    // 不能取 .at(-1)：模块内其它 invoke（如 get_profile_info）可能排在后面，会拿错调用。
    const stepCalls = core.invoke.mock.calls.filter(([c]) => c === 'cua_glow_overlay_step')
    const args = stepCalls.at(-1)[1]
    expect(args).toMatchObject({ elapsedMs: 65000, running: false })
  })
})
