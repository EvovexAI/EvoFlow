export type StreamBumpOptions = { 
  /** Skip coalescing, fire immediately on next microtask */
  immediate?: boolean
  /** Use rAF instead of setTimeout for lower latency (default: false) */
  lowLatency?: boolean
}

type MinIntervalMs = number | (() => number)

function resolveMinIntervalMs(minIntervalMs: MinIntervalMs): number {
  const v = typeof minIntervalMs === 'function' ? minIntervalMs() : minIntervalMs
  return Number.isFinite(v) && v >= 0 ? v : 100
}

/** Coalesce high-frequency stream UI bumps (SSE deltas/tools) to at most ~minIntervalMs. */
export function createStreamBumpScheduler(bump: () => void, minIntervalMs: MinIntervalMs = 100) {
  let timeoutId = 0
  let rafId = 0
  let pending = false
  let lastBumpAt = 0

  const clearTimers = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = 0
    }
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
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
      if (timeoutId || rafId) return

      if (opts?.lowLatency) {
        // rAF for smooth streaming: fires before next paint, lowest latency
        // Suitable for high-frequency text/reasoning updates.
        // 之前是 rAF → scheduleLater() → setTimeout(wait) 链路，最坏 16ms(rAF) + 16ms(setTimeout) = 32ms。
        // 优化：rAF 触发后直接根据 elapsed 决定立即 runBump 还是 setTimeout(wait) 一次。
        //   - elapsed ≥ minIntervalMs → 立即 runBump
        //   - 否则等剩余时间（保持 throttle，又不重复 vsync）
        rafId = requestAnimationFrame(() => {
          rafId = 0
          if (!pending) return
          const wait = resolveMinIntervalMs(minIntervalMs) - (Date.now() - lastBumpAt)
          if (wait <= 0) {
            runBump()
          } else {
            timeoutId = window.setTimeout(() => {
              timeoutId = 0
              if (!pending) return
              runBump()
            }, wait)
          }
        })
        return
      }

      // Default: setTimeout(0) coalescing path
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
