import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { positionMenuAbovePoint } from '../lib/session-list/menu-position.js'

export type EmployeeGroupContextMenuState = {
  agentCode: string
  label: string
  x: number
  y: number
}

type EmployeeGroupContextMenuPortalProps = {
  menu: EmployeeGroupContextMenuState | null
  focused?: boolean
  /** 该员工下是否有正在执行的会话 */
  canStop?: boolean
  onClose: () => void
  onFocusOnly: () => void
  onClearFocus?: () => void
  onNewChat: () => void
  onRefresh?: () => void
  onStop?: () => void
  onOpenEmployeePage: () => void
}

export function EmployeeGroupContextMenuPortal({
  menu,
  focused = false,
  canStop = false,
  onClose,
  onFocusOnly,
  onClearFocus,
  onNewChat,
  onRefresh,
  onStop,
  onOpenEmployeePage,
}: EmployeeGroupContextMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const onDocClick = (e: Event) => {
      if (!(e.target as HTMLElement).closest('.react-chat-workspace-context-menu')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setPos(null)
      return
    }
    const el = menuRef.current
    setPos(positionMenuAbovePoint(menu.x, menu.y, el.offsetWidth, el.offsetHeight, { gap: 6 }))
  }, [menu, focused])

  if (!menu) return null

  return createPortal(
    <div
      ref={menuRef}
      className="react-chat-workspace-context-menu"
      role="menu"
      style={
        pos
          ? { position: 'fixed', left: pos.left, top: pos.top, zIndex: 12000, visibility: 'visible' }
          : { position: 'fixed', left: menu.x, top: menu.y, visibility: 'hidden' }
      }
    >
      {focused ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onClearFocus?.()}
        >
          显示全部 BOT
        </button>
      ) : (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onFocusOnly()}
        >
          只看此 BOT
        </button>
      )}
      <button
        type="button"
        className="react-chat-workspace-context-menu-item"
        onClick={() => onNewChat()}
      >
        新开对话
      </button>
      {onRefresh ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onRefresh()}
        >
          刷新会话
        </button>
      ) : null}
      {canStop && onStop ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item react-chat-workspace-context-menu-item--danger"
          onClick={() => onStop()}
        >
          停止执行
        </button>
      ) : null}
      <button
        type="button"
        className="react-chat-workspace-context-menu-item"
        onClick={() => onOpenEmployeePage()}
      >
        打开 BOT 页
      </button>
    </div>,
    document.body,
  )
}
