import { useEffect, useRef, useState } from 'react'
import { HoverBubble } from './HoverBubble.js'

export interface SubtaskLiveTickerProps {
  text: string
  className?: string
  title?: string
}

/** Horizontal marquee when text overflows (workflow nodes + subtask cards). */
export function SubtaskLiveTicker({ text, className = '', title }: SubtaskLiveTickerProps) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [scroll, setScroll] = useState(false)
  const content = String(text || '').trim()

  useEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner || !content) {
      setScroll(false)
      return
    }
    const dist = Math.max(0, inner.scrollWidth - outer.clientWidth)
    if (dist > 6) {
      setScroll(true)
      inner.style.setProperty('--subtask-ticker-dist', `${dist}px`)
      const sec = Math.min(22, Math.max(7, dist / 28))
      inner.style.setProperty('--subtask-ticker-dur', `${sec}s`)
    } else {
      setScroll(false)
      inner.style.removeProperty('--subtask-ticker-dist')
      inner.style.removeProperty('--subtask-ticker-dur')
    }
  }, [content])

  if (!content) return null

  return (
    <HoverBubble
      text={title || content}
      side="bottom"
      align="start"
      maxWidth={480}
      maxHeight={260}
    >
      <div
        ref={outerRef}
        className={`react-chat-subtask-ticker react-chat-subtask-ticker--fullrow${scroll ? ' react-chat-subtask-ticker--scroll' : ''} ${className}`.trim()}
      >
        <span ref={innerRef} className="react-chat-subtask-ticker__inner">
          {content}
        </span>
      </div>
    </HoverBubble>
  )
}
