import { useEffect, useRef, useState } from 'react'

/** 高频流式更新时节流到至多每 intervalMs 刷新一次 UI。 */
export function useThrottledValue<T>(value: T, intervalMs: number, active: boolean): T {
  const [shown, setShown] = useState(value)
  const latestRef = useRef(value)
  const lastFlushRef = useRef(0)
  const timerRef = useRef(0)

  useEffect(() => {
    latestRef.current = value
  })

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    if (!active) {
      queueMicrotask(() => setShown(value))
      return
    }
    const now = Date.now()
    const wait = Math.max(0, intervalMs - (now - lastFlushRef.current))
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0
      lastFlushRef.current = Date.now()
      setShown(latestRef.current)
    }, wait)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = 0
      }
    }
  }, [value, active, intervalMs])

  return active ? shown : value
}
