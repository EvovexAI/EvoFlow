export type StreamBumpOptions = { immediate?: boolean }

type MinIntervalMs = number | (() => number)

function resolveMinIntervalMs(minIntervalMs: MinIntervalMs): number {
  const v = typeof minIntervalMs === 'function' ? minIntervalMs() : minIntervalMs
  return Number.isFinite(v) && v >= 0 ? v : 100
}

/** Coalesce high-frequency stream UI bumps (SSE deltas/tools) to at most ~minIntervalMs. */
export function createStreamBumpScheduler(bump: () => void, minIntervalMs: MinIntervalMs = 100) {
  let timeoutId = 0
  let pending = false
  let lastBumpAt = 0

  const clearTimers = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = 0
    }
  }

  const runBump = () => {
    pending = false
    lastBumpAt = Date.now()
    bump()
  }

  const flushPending = () => {
    clearTimers()
    if (!pending) return
    runBump()
  }

  const scheduleLater = () => {
    const wait = Math.max(0, resolveMinIntervalMs(minIntervalMs) - (Date.now() - lastBumpAt))
    if (wait <= 0) {
      runBump()
      return
    }
    timeoutId = window.setTimeout(() => {
      timeoutId = 0
      if (!pending) return
      runBump()
    }, wait)
  }

  return {
    schedule(opts?: StreamBumpOptions) {
      if (opts?.immediate) {
        clearTimers()
        pending = false
        runBump()
        return
      }
      pending = true
      if (timeoutId) return
      // 用 setTimeout(0) 替代 requestAnimationFrame：
      // rAF 绑定浏览器绘制周期，主线程被高频 SSE 事件占满时回调被持续推迟，
      // 导致思考内容被缓冲不显示，直到工具/正文事件触发额外重渲染才刷出。
      // setTimeout(0) 在当前宏任务结束后立即执行，不受绘制周期阻塞。
      timeoutId = window.setTimeout(() => {
        timeoutId = 0
        if (!pending) return
        scheduleLater()
      }, 0)
    },
    flush() {
      flushPending()
    },
    cancelPending() {
      clearTimers()
      pending = false
    },
    dispose() {
      clearTimers()
      pending = false
    },
  }
}
