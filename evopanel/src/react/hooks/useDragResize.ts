import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type Axis = 'x' | 'y'

export function useDragResize({
  axis,
  onDragDelta,
  onDragEnd,
  enabled = true,
}: {
  axis: Axis
  onDragDelta: (delta: number) => void
  onDragEnd?: () => void
  enabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ x: 0, y: 0 })
  const onDragDeltaRef = useRef(onDragDelta)
  const onDragEndRef = useRef(onDragEnd)

  useEffect(() => {
    onDragDeltaRef.current = onDragDelta
  }, [onDragDelta])

  useEffect(() => {
    onDragEndRef.current = onDragEnd
  }, [onDragEnd])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)
      startRef.current = { x: e.clientX, y: e.clientY }
      setDragging(true)

      const onMove = (ev: PointerEvent) => {
        const delta =
          axis === 'x' ? ev.clientX - startRef.current.x : ev.clientY - startRef.current.y
        if (!delta) return
        startRef.current = { x: ev.clientX, y: ev.clientY }
        onDragDeltaRef.current(delta)
      }
      const onUp = (ev: PointerEvent) => {
        try {
          target.releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        setDragging(false)
        onDragEndRef.current?.()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [axis, enabled],
  )

  useEffect(() => {
    if (!dragging) return
    const cls = axis === 'x' ? 'evopanel-layout-dragging-x' : 'evopanel-layout-dragging-y'
    document.body.classList.add(cls)
    return () => document.body.classList.remove(cls)
  }, [dragging, axis])

  return { onPointerDown, dragging }
}
