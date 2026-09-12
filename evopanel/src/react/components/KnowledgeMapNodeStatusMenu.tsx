import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  USER_NODE_STATUS_OPTIONS,
  userStatusOptionLabel,
} from '../../lib/knowledge-map-node-status.js'
import { normalizeNodeStatus } from '../../lib/knowledge-map-tree.js'

export type StatusMenuPlacement = 'left' | 'right' | 'below' | 'auto'

export interface StatusMenuAnchor {
  left: number
  top: number
  width: number
  height: number
  placement?: StatusMenuPlacement
}

export function statusMenuAnchorFromElement(
  el: HTMLElement,
  placement: StatusMenuPlacement = 'auto',
): StatusMenuAnchor {
  const rect = el.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    placement,
  }
}

export function statusMenuAnchorFromPoint(
  clientX: number,
  clientY: number,
  placement: StatusMenuPlacement = 'auto',
): StatusMenuAnchor {
  return { left: clientX, top: clientY, width: 0, height: 0, placement }
}

function computeMenuPosition(
  menuW: number,
  menuH: number,
  anchor: StatusMenuAnchor,
  viewportW: number,
  viewportH: number,
): { left: number; top: number } {
  const gap = 8
  let placement = anchor.placement ?? 'auto'
  if (placement === 'auto') {
    const cx = anchor.left + Math.max(anchor.width, 1) / 2
    placement = cx > viewportW * 0.52 ? 'left' : 'right'
  }

  let left = anchor.left
  let top = anchor.top

  if (placement === 'left') {
    left = anchor.left - menuW - gap
    top = anchor.top + anchor.height / 2 - menuH / 2
  } else if (placement === 'right') {
    left = anchor.left + anchor.width + gap
    top = anchor.top + anchor.height / 2 - menuH / 2
  } else if (placement === 'below') {
    left = anchor.left
    top = anchor.top + anchor.height + gap
  }

  left = Math.max(gap, Math.min(left, viewportW - menuW - gap))
  top = Math.max(gap, Math.min(top, viewportH - menuH - gap))
  return { left, top }
}

export function KnowledgeMapNodeStatusMenu({
  nodeId,
  currentStatus,
  anchor,
  onSelect,
  onClose,
  saving = false,
}: {
  nodeId: string
  currentStatus?: string
  anchor: StatusMenuAnchor
  onSelect: (status: string) => void
  onClose: () => void
  saving?: boolean
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const cur = normalizeNodeStatus(currentStatus)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPosition(
      computeMenuPosition(width, height, anchor, window.innerWidth, window.innerHeight),
    )
  }, [anchor])

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const el = menuRef.current
      if (!el || el.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const handlePick = (e: ReactMouseEvent<HTMLButtonElement>, value: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (saving || value === cur) {
      onClose()
      return
    }
    onSelect(value)
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={menuRef}
      className={`km-node-status-menu${position ? ' is-positioned' : ''}`}
      style={position ? { left: position.left, top: position.top } : undefined}
      role="menu"
      aria-label={`修改节点状态：${nodeId}`}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="km-node-status-menu-head">修改状态</div>
      <div className="km-node-status-menu-current">
        当前：<strong>{userStatusOptionLabel(cur)}</strong>
      </div>
      {USER_NODE_STATUS_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="menuitemradio"
          aria-checked={opt.value === cur}
          className={`km-node-status-menu-item${opt.value === cur ? ' is-current' : ''}${opt.primary ? ' is-primary' : ''}`}
          disabled={saving}
          onClick={(e) => handlePick(e, opt.value)}
        >
          <span className="km-node-status-menu-item-label">{opt.label}</span>
          {opt.hint ? <span className="km-node-status-menu-item-hint">{opt.hint}</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  )
}
