import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** 限高 + 顶栏淡出 + 流式/执行中自动滚到底（Exploring / 子智能体共用） */
export function ScrollFadeViewport({
  children,
  className = '',
  rowHeight = 28,
  visibleRows = 5,
  stickToBottom = false,
  style,
}: {
  children: ReactNode
  className?: string
  /** 单行预估高度（px） */
  rowHeight?: number
  /** 可见行数 */
  visibleRows?: number
  /** 为 true 时内容增高则 scrollTop = scrollHeight */
  stickToBottom?: boolean
  style?: CSSProperties
}) {
  const [overflowing, setOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const syncViewport = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const canScroll = el.scrollHeight > el.clientHeight + 1
    setOverflowing(canScroll)
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [stickToBottom])

  useEffect(() => {
    syncViewport()
  }, [children, syncViewport])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    syncViewport()
    const ro = new ResizeObserver(() => syncViewport())
    ro.observe(el)
    for (const child of el.children) {
      ro.observe(child)
    }
    return () => ro.disconnect()
  }, [syncViewport])

  return (
    <div
      ref={scrollRef}
      className={`scroll-fade-viewport${overflowing ? ' is-overflowing' : ''}${className ? ` ${className}` : ''}`}
      style={
        {
          ...style,
          ['--scroll-fade-row-h' as string]: `${rowHeight}px`,
          ['--scroll-fade-visible-rows' as string]: String(visibleRows),
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}
