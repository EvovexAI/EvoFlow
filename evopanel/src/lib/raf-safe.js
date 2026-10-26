/**
 * requestAnimationFrame 兜底：WebView2/嵌入 webview 在窗口被遮挡、最小化或
 * 后台节流时可能长时间不派发 rAF（实测可 >120s），裸依赖 rAF 的逻辑会永久挂起。
 * 这里保证回调最多在 timeoutMs 内仍会执行；rAF 与 setTimeout 谁先到谁触发，只触发一次。
 *
 * @param {() => void} cb
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {() => void} cancel
 */
export function nextFrameSafe(cb, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 64
  let done = false
  let rafId = 0
  let timer = 0
  const run = () => {
    if (done) return
    done = true
    cancelAnimationFrame(rafId)
    clearTimeout(timer)
    cb()
  }
  try {
    rafId = requestAnimationFrame(run)
  } catch {
    /* rAF 不可用时仅靠定时器兜底 */
  }
  timer = setTimeout(run, timeoutMs)
  return () => {
    done = true
    cancelAnimationFrame(rafId)
    clearTimeout(timer)
  }
}
