import { useEffect, useRef, useState, type ReactNode } from 'react'

type Size = { width: number; height: number }

/**
 * Only mount chart children once the container has a non-zero box.
 * Avoids Recharts "width(0) and height(0)" spam when the home dashboard
 * lays out inside a flex/scroller that is still 0×0 on the first paint.
 */
export function ChartSizeGate({
  className,
  children,
}: {
  className?: string
  children: (size: Size) => ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const apply = (width: number, height: number) => {
      const w = Math.floor(width)
      const h = Math.floor(height)
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }))
    }

    apply(el.clientWidth, el.clientHeight)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      apply(width, height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ready = size.width > 0 && size.height > 0

  return (
    <div ref={ref} className={className} style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      {ready ? children(size) : null}
    </div>
  )
}
