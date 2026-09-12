import type { PointerEventHandler } from 'react'

type PanelResizeHandleProps = {
  direction: 'horizontal' | 'vertical'
  onPointerDown: PointerEventHandler<HTMLDivElement>
  dragging?: boolean
  label: string
  className?: string
}

export function PanelResizeHandle({
  direction,
  onPointerDown,
  dragging = false,
  label,
  className = '',
}: PanelResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      className={`react-chat-panel-resize-handle react-chat-panel-resize-handle--${direction}${
        dragging ? ' is-dragging' : ''
      }${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
    />
  )
}
