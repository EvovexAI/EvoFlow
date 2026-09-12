import { useEffect, useRef } from 'react'

/**
 * 聊天区拉取历史时的圆环：部分桌面 WebView 在 absolute 遮罩内对 CSS animation/transform 不重绘，
 * 用 rAF 写 inline transform，与路由里 .page-loader-spinner 视觉一致。
 */
export function HistoryFetchSpinner() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const t0 = performance.now()
    const periodMs = 800
    const tick = (now: number) => {
      const deg = (((now - t0) / periodMs) * 360) % 360
      el.style.transform = `rotate(${deg}deg) translateZ(0)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <div ref={ref} className="react-chat-history-rAF-spinner" aria-hidden />
}
