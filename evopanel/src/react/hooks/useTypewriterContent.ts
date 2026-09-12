import { useEffect, useRef, useState } from 'react'

/**
 * 流式正文：目标文本增长时以打字机节奏追赶；非流式时直接展示全文。
 */
export function useTypewriterContent(target: string, active: boolean, charsPerFrame = 28) {
  const [shown, setShown] = useState(target)
  const targetRef = useRef(target)
  const shownLenRef = useRef(target.length)
  
  // Update ref in effect to avoid accessing ref during render
  useEffect(() => {
    targetRef.current = target
  }, [target])

  useEffect(() => {
    if (!active) {
      shownLenRef.current = target.length
      // Defer state update to avoid cascading renders
      requestAnimationFrame(() => {
        setShown(target)
      })
      return
    }
    let raf = 0
    const step = () => {
      const t = targetRef.current
      if (shownLenRef.current >= t.length) {
        setShown(t)
        return
      }
      const nextLen = Math.min(shownLenRef.current + charsPerFrame, t.length)
      shownLenRef.current = nextLen
      setShown(t.slice(0, nextLen))
      if (nextLen < t.length) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, active, charsPerFrame])

  useEffect(() => {
    if (!active) return
    // Defer state update to avoid cascading renders
    requestAnimationFrame(() => {
      setShown((prev) => {
        const t = target
        if (t.length < prev.length) return t
        if (prev.length >= t.length) return prev
        return prev
      })
    })
  }, [target, active])

  return active ? shown : target
}
