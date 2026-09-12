import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { positionMenuAbovePoint } from '../lib/session-list/menu-position.js'
import type { ShellWorkspaceGroup } from '../lib/session-list/types.js'
import { WORKSPACE_GROUP_UNBOUND } from '../lib/session-list/workspace-groups.js'

export type WorkspaceFolderContextMenuState = {
  workspaceKey: string
  x: number
  y: number
}

type WorkspaceFolderContextMenuPortalProps = {
  menu: WorkspaceFolderContextMenuState | null
  group: ShellWorkspaceGroup | null
  canOpenFolder?: boolean
  canPin?: boolean
  isPinned?: boolean
  canFocus?: boolean
  onClose: () => void
  onOpenFolder?: () => void
  onTogglePin?: () => void
  onFocusOnly?: () => void
  onDelete: () => void
}

export function WorkspaceFolderContextMenuPortal({
  menu,
  group,
  canOpenFolder = false,
  canPin = false,
  isPinned = false,
  canFocus = false,
  onClose,
  onOpenFolder,
  onTogglePin,
  onFocusOnly,
  onDelete,
}: WorkspaceFolderContextMenuPortalProps) {
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
    setPos(
      positionMenuAbovePoint(menu.x, menu.y, el.offsetWidth, el.offsetHeight, { gap: 6 }),
    )
  }, [menu, group?.sessionCount, canOpenFolder, canPin, canFocus, isPinned])

  if (!menu || !group) return null

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
      {canFocus ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onFocusOnly?.()}
        >
          只看此空间对话
        </button>
      ) : null}
      {canPin ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onTogglePin?.()}
        >
          {isPinned ? '取消收藏' : '收藏到侧栏'}
        </button>
      ) : null}
      {canOpenFolder ? (
        <button
          type="button"
          className="react-chat-workspace-context-menu-item"
          onClick={() => onOpenFolder?.()}
        >
          {canOpenFolder && group.workspaceKey === WORKSPACE_GROUP_UNBOUND
            ? '打开默认数据目录'
            : '打开文件夹'}
        </button>
      ) : null}
      <button
        type="button"
        className="react-chat-workspace-context-menu-item react-chat-workspace-context-menu-item--danger"
        onClick={() => onDelete()}
      >
        {group.sessionCount > 0 ? '删除工作空间及会话' : '从侧栏移除'}
      </button>
    </div>,
    document.body,
  )
}
