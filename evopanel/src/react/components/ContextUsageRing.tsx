import { useEffect, useMemo, useRef, useState } from 'react'
import { ContextOccupancyPanel } from './ContextOccupancyPanel.js'
import {
  contextUsageLevel,
  contextUsageRatio,
  type ContextUsageSnapshot,
} from '../lib/context-usage.js'
import type { TokenTotals } from '../chat-types.js'

type Props = {
  usage: ContextUsageSnapshot | null
  tokenTotals?: TokenTotals | null
  compacting?: boolean
  className?: string
  /** Manual compaction from the open panel (DeepSeek: ring opens panel). */
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
}

const RING_SIZE = 16
const STROKE = 2
const RADIUS = (RING_SIZE - STROKE) / 2
const CIRC = 2 * Math.PI * RADIUS

export function ContextUsageRing({
  usage,
  tokenTotals = null,
  compacting = false,
  className = '',
  onManualCompact,
  manualCompactDisabled = false,
}: Props) {
  const [displayRatio, setDisplayRatio] = useState(0)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const prevUsedRef = useRef(0)

  const targetRatio = useMemo(() => {
    if (!usage || usage.windowTokens <= 0) return 0
    return contextUsageRatio(usage.usedTokens, usage.windowTokens)
  }, [usage])

  const available = !!(usage && usage.windowTokens > 0 && usage.usedTokens > 0)

  useEffect(() => {
    if (!usage) {
      queueMicrotask(() => setDisplayRatio(0))
      prevUsedRef.current = 0
      return
    }
    const shrunk = usage.compacted && usage.usedTokens < prevUsedRef.current
    prevUsedRef.current = usage.usedTokens
    if (shrunk) {
      const id = window.requestAnimationFrame(() => setDisplayRatio(targetRatio))
      return () => window.cancelAnimationFrame(id)
    }
    setDisplayRatio(targetRatio)
  }, [usage, targetRatio])

  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  useEffect(() => {
    if (!open || !available) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, available])

  if (!available || !usage) return null

  const level = contextUsageLevel(displayRatio)
  const dashOffset = CIRC * (1 - displayRatio)
  const pctLabel = Math.round(displayRatio * 100)

  return (
    <span ref={rootRef} className={`react-chat-context-ring-wrap${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`react-chat-context-ring react-chat-context-ring--${level}${compacting ? ' is-compacting' : ''}${
          usage.compacted ? ' is-compacted' : ''
        } is-clickable`}
        aria-label={`上下文已用 ${pctLabel}%`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={open ? undefined : `上下文已用 ${pctLabel}% · 点击查看拆分`}
        data-tauri-no-drag
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <svg
          className="react-chat-context-ring-svg"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden="true"
        >
          <circle
            className="react-chat-context-ring-track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className="react-chat-context-ring-fill"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${CIRC} ${CIRC}`}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
        <span className="react-chat-context-ring-pct" aria-hidden="true">
          {pctLabel}%
        </span>
      </button>
      {open ? (
        <div
          className="react-chat-context-ring-panel"
          role="dialog"
          aria-label="上下文占用"
          onClick={(e) => e.stopPropagation()}
        >
          <ContextOccupancyPanel
            usage={usage}
            tokenTotals={tokenTotals}
            compacting={compacting}
            onManualCompact={onManualCompact}
            manualCompactDisabled={manualCompactDisabled}
          />
        </div>
      ) : null}
    </span>
  )
}
