import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 回归：右栏 Agent 应用（主 webview 里的 iframe）弹窗不得逃到系统浏览器。
 *
 * 背景：扩展页里 `window.open()` / `<a target="_blank">`（导出文件、跳外站）
 * 会触发主 webview 的 NewWindowRequested。主窗口没装 handler 时，WebView2
 * 走默认行为 → 弹到系统默认浏览器，于是「右栏开应用」时浏览器也冒出来。
 *
 * 对照：浏览器面板（browser kind）是独立 WebView2，已有
 * `install_same_window_popup_takeover`；主窗口缺这一层，
 * 本次补 `main_popup_guard.rs`。
 */

const RUST_GUARD = resolve(__dirname, '../src-tauri/src/commands/main_popup_guard.rs')
const LIB_RS = resolve(__dirname, '../src-tauri/src/lib.rs')
const MOD_RS = resolve(__dirname, '../src-tauri/src/commands/mod.rs')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('主窗口弹窗拦截', () => {
  const guardSrc = read(RUST_GUARD)
  const libSrc = read(LIB_RS)
  const modSrc = read(MOD_RS)

  it('模块已注册', () => {
    expect(modSrc).toMatch(/pub mod main_popup_guard;/)
    expect(libSrc).toContain('commands::main_popup_guard::install_main_window_popup_guard')
  })

  it('装的是 NewWindowRequested 同步 handler（不是 Tauri 的延迟 on_new_window）', () => {
    // Tauri 的 on_new_window(Deny) 是延迟回调，WebView2 的未托管 "Web Viewer"
    // 宿主仍可能冒出来；必须用同步 COM handler。
    expect(guardSrc).toContain('NewWindowRequestedEventHandler')
    expect(guardSrc).toContain('add_NewWindowRequested')
    // 注释里可以提 on_new_window（解释为什么不使用它），但不能真的调用它。
    const code = guardSrc
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    expect(code).not.toContain('on_new_window')
  })

  it('重试循环不在 UI 线程里跑（否则与 with_webview 回调互锁）', () => {
    // with_webview 的回调要在 UI 线程派发；若重试循环也占着 UI 线程
    // （run_on_main_thread 内 sleep + 等 channel），回调永远等不到 → 死锁。
    // 所以：UI 线程只做一次派发，等待 + 重试必须在后台线程。
    const guardBody = guardSrc.slice(guardSrc.indexOf('pub fn install_main_window_popup_guard'))
    const uiDispatch = guardBody.slice(0, guardBody.indexOf('fn install_on_window'))
    expect(uiDispatch).not.toMatch(/run_on_main_thread\([^)]*move \|\| \{[^}]*sleep/)
    expect(uiDispatch).toContain('recv_timeout')
    // 后台线程自己 spawn
    expect(uiDispatch).toContain('.spawn(move ||')
  })

  it('一律 SetHandled(true)：绝不放行到系统浏览器', () => {
    expect(guardSrc).toContain('SetHandled(true)')
  })

  it('扩展本地服务（loopback）的弹窗就地吞掉，不外跳', () => {
    expect(guardSrc).toContain('fn is_loopback')
    expect(guardSrc).toMatch(/is_loopback\(&uri\)/)
    expect(guardSrc).toContain('127.0.0.1')
    expect(guardSrc).toContain('localhost')
  })

  it('handler 泄漏保活（必须比 webview 活得久）', () => {
    expect(guardSrc).toContain('std::mem::forget(handler)')
  })
})
