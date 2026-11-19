/**
 * 提示条「已操作时长」的**页面侧**行为。
 *
 * 【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么单独测页面而不是只测后端：
 *   Rust 侧只推一个整数 elapsed_ms，**秒数增长与停表全部发生在页面里**。
 *   `node --check` / `cargo check` 对「秒不动」「跑停了还在跳」零分辨力，
 *   真机上这两种都只是「数字看起来怪」，不会抛异常，靠肉眼看 5 秒也分不出来。
 *
 * 判据（每条都对应一种用户真能看见的错误）：
 *   ① 刚开始 base=0 也要显示 "0s" —— 否则用户以为没加时长功能；
 *   ② running=true 时每秒自己涨 —— 不靠轮询推（步骤不变时推送会早退，秒会冻住）；
 *   ③ running=false 立刻停表并清掉 interval —— 否则「已停止但秒数还在跳」；
 *   ④ 空闲（0 且没在跑）时该段整个隐藏，不留一个孤零零的 "0s"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const HTML_PATH = path.resolve(__dirname, '../cua-glow-overlay.html')

/** 只取 body 里的静态骨架（去掉 <script>），再手动执行脚本 —— 与 WebView2 里的顺序一致。 */
function bootPage() {
  const html = fs.readFileSync(HTML_PATH, 'utf8')
  const bodyOpen = html.indexOf('<body')
  const bodyStart = html.indexOf('>', bodyOpen) + 1
  const bodyEnd = html.lastIndexOf('</body>')
  const body = html.slice(bodyStart, bodyEnd).replace(/<script[\s\S]*?<\/script>/g, '')
  document.body.innerHTML = body
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!script) throw new Error('cua-glow-overlay.html 里没有内联脚本 —— 测试前提不成立')
  new Function(script[1])()
  return document.getElementById('cua-glow-elapsed')
}

describe('提示条时长（页面侧秒表）', () => {
  let elapsedEl

  beforeEach(() => {
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    vi.useFakeTimers()
    elapsedEl = bootPage()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('刚开始（base=0）就显示 0s，并在 running 时每秒自己涨', () => {
    window.__cuaGlowOverlay.setStep('正在点击', 1, 0, true)
    expect(elapsedEl.textContent).toBe('0s')

    vi.advanceTimersByTime(3000)
    expect(elapsedEl.textContent).toBe('3s')

    // 紧接着再推一次 5000ms（模拟轮询带了更新值），应从 5s 继续，不回跳
    window.__cuaGlowOverlay.setStep('正在点击', 1, 5000, true)
    expect(elapsedEl.textContent).toBe('5s')
    vi.advanceTimersByTime(2000)
    expect(elapsedEl.textContent).toBe('7s')
  })

  it('running=false 立刻停表，之后推进时间数字不再变', () => {
    window.__cuaGlowOverlay.setStep('正在输入', 2, 12000, true)
    vi.advanceTimersByTime(1000)
    expect(elapsedEl.textContent).toBe('13s')

    window.__cuaGlowOverlay.setStep('正在输入', 2, 13500, false)
    expect(elapsedEl.textContent).toBe('13s')

    vi.advanceTimersByTime(10000)
    expect(elapsedEl.textContent).toBe('13s')
  })

  it('空闲时整段隐藏，不留孤零零的 0s', () => {
    window.__cuaGlowOverlay.setStep('', 0, 0, false)
    expect(elapsedEl.textContent).toBe('')
  })

  it('超过 1 分钟用 m:ss，超过 1 小时用 h:mm:ss', () => {
    window.__cuaGlowOverlay.setStep('正在滚动', 3, 65000, false)
    expect(elapsedEl.textContent).toBe('1:05')

    window.__cuaGlowOverlay.setStep('正在滚动', 3, 3723000, false)
    expect(elapsedEl.textContent).toBe('1:02:03')
  })

  it('第 1 步不显示计数，第 2 步起显示「第 N 步」，且与时长共存', () => {
    const countEl = document.getElementById('cua-glow-count')
    const stepEl = document.getElementById('cua-glow-step')

    window.__cuaGlowOverlay.setStep('正在点击', 1, 0, true)
    expect(countEl.textContent).toBe('')
    expect(stepEl.textContent).toBe('正在点击')

    window.__cuaGlowOverlay.setStep('正在输入', 2, 0, true)
    expect(countEl.textContent).toBe('第 2 步')
    expect(elapsedEl.textContent).toBe('0s')
  })
})
