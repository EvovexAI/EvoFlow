import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { positionMenuAbovePoint } from '../lib/session-list/menu-position.js'
import type { ChatArtifact } from '../lib/chat-artifact.js'

export type ArtifactContextMenuState = {
  item: ChatArtifact
  x: number
  y: number
}

type Props = {
  menu: ArtifactContextMenuState | null
  onClose: () => void
  onOpen?: (item: ChatArtifact) => void
  onReveal?: (item: ChatArtifact) => void
  onOpenUrl?: (item: ChatArtifact) => void
}

export function ArtifactContextMenuPortal({
  menu,
  onClose,
  onOpen,
  onReveal,
  onOpenUrl,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const onDoc = (e: Event) => {
      if (!(e.target as HTMLElement).closest('.react-chat-artifact-context-menu')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setPos(null)
      return
    }
    const el = menuRef.current
    setPos(positionMenuAbovePoint(menu.x, menu.y, el.offsetWidth, el.offsetHeight, { gap: 4 }))
  }, [menu])

  if (!menu) return null
  const { item } = menu
  const hasPath = !!String(item.path || '').trim()
  const hasUrl = !!String(item.url || '').trim()

  return createPortal(
    <div
      ref={menuRef}
      className="react-chat-artifact-context-menu"
      role="menu"
      style={
        pos
          ? { position: 'fixed', left: pos.left, top: pos.top, zIndex: 12000, visibility: 'visible' }
          : { position: 'fixed', left: menu.x, top: menu.y, visibility: 'hidden' }
      }
    >
      {hasPath && onOpen ? (
        <button
          type="button"
          className="react-chat-artifact-context-menu-item"
          role="menuitem"
          onClick={() => {
            onOpen(item)
            onClose()
          }}
        >
          打开预览
        </button>
      ) : null}
      {hasPath && onReveal ? (
        <button
          type="button"
          className="react-chat-artifact-context-menu-item"
          role="menuitem"
          onClick={() => {
            onReveal(item)
            onClose()
          }}
        >
          打开所在位置
        </button>
      ) : null}
      {hasUrl && onOpenUrl ? (
        <button
          type="button"
          className="react-chat-artifact-context-menu-item"
          role="menuitem"
          onClick={() => {
            onOpenUrl(item)
            onClose()
          }}
        >
          在浏览器打开
        </button>
      ) : null}
    </div>,
    document.body,
  )
}
