/**
 * 圆形胶囊 HUD「已操作时长」的页面侧行为。
 *
 * 判据：
 *   ① 刚开始 base=0 也要显示 "0s"；
 *   ② running=true 时每秒自己涨；
 *   ③ running=false 立刻停表；
 *   ④ 空闲时整段隐藏；
 *   ⑤ 第 1 步起就显示「第 N 步」（胶囊面上的步数）；
 *   ⑥ 已在跑时误推 stale/0 的 elapsed 不得把秒数打回 0。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const HTML_PATH = path.resolve(__dirname, '../cua-glow-overlay.html')

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

describe('圆形胶囊 HUD 时长与步数（页面侧）', () => {
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

  it('第 1 步起就显示「第 N 步」，且与时长共存', () => {
    const countEl = document.getElementById('cua-glow-count')

    window.__cuaGlowOverlay.setStep('正在点击', 1, 0, true)
    expect(countEl.textContent).toBe('第 1 步')
    expect(elapsedEl.textContent).toBe('0s')

    window.__cuaGlowOverlay.setStep('正在输入', 2, 3000, true)
    expect(countEl.textContent).toBe('第 2 步')
    expect(elapsedEl.textContent).toBe('3s')
  })

  it('已在跑时误推 elapsed=0 不得把秒数打回 0s', () => {
    window.__cuaGlowOverlay.setStep('正在点击', 1, 0, true)
    vi.advanceTimersByTime(8000)
    expect(elapsedEl.textContent).toBe('8s')

    // 步骤推进时跨进程偶发 stale/0 —— 胶囊面上秒数必须继续走，不能回跳。
    window.__cuaGlowOverlay.setStep('正在输入', 2, 0, true)
    expect(elapsedEl.textContent).toBe('8s')
    vi.advanceTimersByTime(2000)
    expect(elapsedEl.textContent).toBe('10s')
  })

  it('HUD 是圆形胶囊，没有白色长方形底框', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8')
    expect(html).toMatch(/border-radius:\s*999px/)
    expect(html).toMatch(/background:\s*transparent\s*!important/)
    expect(html).not.toMatch(/background:\s*#ffffff/)
    expect(html).not.toMatch(/#cua-glow-label/)
  })
})
