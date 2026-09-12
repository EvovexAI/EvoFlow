import { useEffect, useRef, useState } from 'react'

/** 将数字从当前展示值平滑递增/递减到目标值（会话切换等回退时立即跳变）。 */
export function useAnimatedCount(target: number, options?: { durationMs?: number; enabled?: boolean }): number {
  const enabled = options?.enabled !== false
  const baseDuration = options?.durationMs ?? 600
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  const targetRef = useRef(target)

  useEffect(() => {
    targetRef.current = target
    if (!enabled) {
      displayRef.current = target
      queueMicrotask(() => setDisplay(target))
      return
    }

    const from = displayRef.current
    const to = target
    if (from === to) return

    if (to < from) {
      displayRef.current = to
      setDisplay(to)
      return
    }

    const delta = to - from
    const durationMs = Math.min(1400, Math.max(350, baseDuration + delta * 0.8))
    const start = performance.now()
    let raf = 0

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const eased = 1 - (1 - t) ** 3
      const val = Math.round(from + delta * eased)
      displayRef.current = val
      setDisplay(val)
      if (t < 1) raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, enabled, baseDuration])

  return enabled ? display : target
}
